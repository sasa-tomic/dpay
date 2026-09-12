# Memory

## Me

Solo founder & engineer building **∂ifferent Pay** (display: ∂pay / Different Pay; technical ASCII: dpay — name decided 2026-08-17, see `2026-08-17-name-decision.md`). Contact: sato.dpay@kalaj.org.
Currently pre-seed: building the investor proof-of-concept, then a first pilot.

## CURRENT TOP PRIORITY — the money the user thinks in (set 2026-09-04)

**The single highest-priority product direction, replacing the native-asset objective below, which
it achieved.** Four objectives, in this order of dependency. **Objective 1 is BUILT (2026-09-04, not
deployed); 2, 3 and 4 are not started** — including the Revolut information architecture itself:

1. **A home currency — CHF · USD · EUR — chosen at onboarding, changeable in Settings.** It sets the
   default asset, the home screen's headline number, and the unit a price is read in. The founder's
   own default is CHF.
2. **A currency is a set of rails, and dpay picks one for the user, on price.** CHF is VCHF on the
   Internet Computer *and* VCHF on Solana; USD is ckUSDC *and* USDC-on-Solana; EUR is EURC on
   Solana. Selecting between rails of the **same** currency is routing, not exchange — the boundary
   that keeps this inside the no-swap non-negotiable is stated in the spec and is not negotiable.
3. **Funding by card, through several licensed providers, landing at the user's own address**;
   conversion, where a currency cannot be bought directly, is a transaction the **user** signs, with
   dpay taking no cut. Gated on an unresolved legal question — see the spec.
4. **Revolut is the golden reference** for the visual system and information architecture. ~~The
   scanner stays the landing screen.~~ **REVERSED by the founder 2026-09-08: the app opens on Home,
   Home is a real overview (balances, movements), and Pay is one tap from it** — greeting a new
   user with a payment-request surface is what read as a scam. Reasoning and the design:
   [`docs/specs/2026-09-08-first-run-redesign.md`](docs/specs/2026-09-08-first-run-redesign.md).

Design, every founder decision, the measured venue/ramp evidence behind them, and the code cost:
[`docs/specs/2026-09-04-currency-first-wallet-plan.md`](docs/specs/2026-09-04-currency-first-wallet-plan.md).
Per-currency asset availability: `positioning.md`. Work order: `OPEN_ISSUES.md`.

**Active addition (founder direction 2026-09-07): delegated conversion PoC** — NOT an exchange;
full integration with existing DeFi/CeFi venues so the user swaps quickly, delegated (the user's
own device signs, recipient/merchant-side first, aligned with the winning precedents), then the
founder asks the officials to confirm the shape. Spec:
[`docs/specs/2026-09-07-delegated-conversion-spec.md`](docs/specs/2026-09-07-delegated-conversion-spec.md).

**Active addition (founder direction 2026-09-08): the first run must not read as a solicitation.**
The founder tried the shipped web wallet and reported it: *"the initial experience is VERY
confusing… several screens that just ask me to pay in some money. Looks like scam."* Three
directions came with it — greet with an introduction and let the user COMPLETE a real payment on
DEMO play money before being asked for a home currency; make Home an overview (balances, movements)
rather than the ten-row currency list, which stays one gesture away; and stop disclosing a pure rail
preference as if it were a reason. Diagnosis, design, the two open founder forks, and the build
order: [`docs/specs/2026-09-08-first-run-redesign.md`](docs/specs/2026-09-08-first-run-redesign.md).

**Active addition (founder directions 2026-09-09).** Three landed together. **(1) A user who holds
nothing is told where to get some** — several providers, unranked, each carrying its OWN published
figures with the date they were read, plus card → native ICP → in-app Convert → VCHF as a funding
route; decisions, the measured evidence and the regulatory checklist it is built against:
[`docs/specs/2026-09-09-funding-routes-plan.md`](docs/specs/2026-09-09-funding-routes-plan.md).
**(2) All Solana traffic — reads AND broadcast — moves behind the dpay relay**, and **(3) dpay
supports several relays for HA**; the two are coupled, the `docs/REGULATORY.md` §4.3 objection to
(2) was raised and overruled, and both are recorded with that objection in
[`docs/specs/2026-09-09-relay-ha-and-solana-proxy.md`](docs/specs/2026-09-09-relay-ha-and-solana-proxy.md).

**Delegating swaps to MORE than one venue (founder, same day): not yet possible.** There is no venue
type at all; the persisted swap record has no venue field and its schema rejects every CeFi record
that will ever exist. What must change first:
[`docs/specs/2026-09-08-multi-venue-readiness.md`](docs/specs/2026-09-08-multi-venue-readiness.md).

When in doubt about sequencing, **pick the work that gets a user holding, and spending, the currency
they actually think in.**

## Previous top priority — native-asset in/out (BTC / ETH / SOL): ACHIEVED (set 2026-08-06)

Both directions are done on all three assets; the residual gates are outer-loop only and live in
`OPEN_ISSUES.md`. Kept below as the evidence record, because these live proofs exist nowhere else.

### Status (2026-08-06)

- **BTC — in/out DONE + testnet-proven (Tier 1).** ckBTC Testnet (currency 3) is registered live on prod `ssqti` (registry-era record — the facade registry was removed 2026-08-28; the relay's compiled catalog is now authoritative, see governance posture); the facade round-trips to the real DFINITY ckBTC Testnet minter (real Testnet4 `tb1q…` deposit address, `min_confirmations=4`, clean NoNewUtxos). Mainnet ckBTC (currency 1) wiring is proven reachable. Full Tier 2 mint is externally blocked (captcha faucet + cycle-starved ckBTC Testnet minter — DFINITY-side infra, not dpay).
- **ETH — in/out DONE + LIVE-PROVEN, BOTH DIRECTIONS on Sepolia.** Proven against prod mainnet IC canisters + real Sepolia ETH. Round-trip: 0.08 SepETH sent to helper `0x2D39863d…` with `depositEth` calldata (tx `0x108c8680…5839`, block #11429442) → minted **0.08 ckSepoliaETH** to the dpay subaccount (minter scraped block 11_429_549, 107 past the deposit); then 0.04 ckSepoliaETH burned (ledger `block_index = 8168`) → **0.039923 real SepETH (39_922_980_593_032_000 Wei) delivered** to the destination. Fee reconciliation ties out (burned 40e15 + 1e7 ledger fee; delivered 39.923e15). Facade WASM upgraded by the founder (family-dispatch live on `ssqti`); currency 5 offramp flipped to Direct; app min-floor fixed (`7dc894a`). Prod relay image redeployed (2026-08-06). **ckERC20(USDC) offramp BUILT** (`d5983ea`): the canister's family dispatch now has a dual-ledger `withdraw_erc20` branch (burns ckERC20 amount + ckETH gas from two separate ledgers); app `cashable` gate flipped; e2e flow 48. User must hold ckETH for gas (Fork-C: no-swap). Prod WASM upgrade required (founder op) to make it live.
- **SOL — MVP DONE + OFFLINE-PAY RAIL (recent-blockhash v2) FULLY BUILT — QR + NFC: native device-key path, NOT ckSOL.** Production ckSOL canisters are **not yet deployed** (IC0537 "no wasm module"). The device holds a Solana ed25519 key directly; the app talks to Solana mainnet through the dpay relay's `/api/v1/solana/rpc` proxy (R2, 2026-09-10) — **no IC canister, no facade, no wire change**; the provider key is deploy config, NOT in the app, and an operator can point Settings ▸ Advanced at any Solana endpoint to remove dpay from the path. Offline pay is unchanged (the payer still signs with no connection; the online side was always online). Online SOL in/out (balance + receive address QR + send/withdraw) is SHIPPED. **Offline-pay rail = recent-blockhash v2** (the 2026-08-13 rewrite retired the durable-nonce design): the payer signs a canonical `{Memo, System.transfer}` (SOL) or `{Memo, Token.transferChecked}` (USDC) message against the merchant's recent blockhash — **no nonce account, no setup, no rent reserve, no advance ix**. `solreq:v2`/`solpay:v2` codec; the merchant strict-verifies the canonical message + payer signature before broadcast (`verifySolPayment` in `app/solana/tx.ts`). QR + **NFC HCE transport** (Kotlin DpaySolNfc — a 2nd independent AID `F06470617902`, pure-Kotlin APDU state machine, no Rust core). v2 invariants: short validity (iat<exp≤iat+90s — the blockhash expires) and unknown-outcome handling (a payment signed offline may land after the blockhash expires → honest pending/unknown state, NOT a guaranteed settle). (The v1 durable-nonce reclaim flow was REMOVED 2026-08-14, founder-directed — the founder is the only user and never held v1 nonce funds.) All inner-loop gates green; **device gate CONFIRMED** (`just app` → `DPAY_SELFCHECK PASS` + `DPAY_SOL_SELFCHECK PASS`, the latter now exercises the real v2 build/verify code path). **Remaining outer-loop:** physical two-phone NFC radio proof for this rail's own HCE transport (the IC rail's hop is now proven on hardware). Mainnet RPC was wired 2026-08-09; since R2 (2026-09-10) the Helius key lives in relay deploy config and the app calls the relay's proxy — nothing provider-shaped ships in the APK.

### What "done" means per direction

- **In (deposit / add money):** the user is given a **real native account/address to send funds to** on each chain (a real BTC/ETH/SOL address). BTC/ETH use IC Chain Fusion ck-minters (per-principal derivation); SOL uses the on-device key directly (deposit = send SOL to the device's address).
- **Out (withdraw / cash out):** BTC/ETH = burn the chain-key asset and the minter sends native to the user's address; SOL = sign a native Solana transfer from the device key.
- **Convenience is a hard requirement, not a nice-to-have.** One-tap address, copy/QR, clear confirmations, honest fees/time.

The BTC/ETH rails layer on the existing facade (minter-family-agnostic; dispatches `CkBtcUtxo` / `CkEthErc20`); the SOL rail is **app-only** and must not touch the facade, wire, or core — and, since R2 (2026-09-10), its RPC reads and broadcasts transit the dpay relay's `/api/v1/solana/rpc` proxy (provider key = deploy config, not the app; Settings ▸ Advanced can point at any Solana endpoint to remove dpay from the path). The IC offline-pay rail is unaffected and must stay untouched.

## Non-negotiable: governance posture (set 2026-08-20)

- **No NNS/SNS handoff.** Moving the canister(s) or the relay under NNS/SNS control is **not realistic until critical mass** — we will not ask the general ICP community to vote on our upgrades. Treat "hand the controller to an SNS/blackhole" as a **deferred end-state**, never a near-term plan item or a blocking gate.
- **Highest architectural objective: safe WITHOUT governance handoff.** The system must be as safe as we can make it while the founder still holds the canister and relay keys. Concretely: least-authority in code (per-op exact-amount approvals, bounded mint), small rotatable scoped keys (faucet controller seed ≠ root keys), cold-storage discipline for the deploy/controller keys, and public verifiability (pinned module hashes) so upgrades are at least *detectable*. Full strategy: `docs/GOVERNANCE.md`.
- **Catalog authority = relay code (founder decision 2026-08-28).** ICP governance will NOT own the facade canister in the foreseeable future, so the governed canister currency registry was pure friction and was REMOVED. The relay (`crates/dpay-relay/src/catalog.rs`, served at `/api/v1/currencies`, drift-alarmed against `dfx/catalog_truth.json`) is the sole catalog authority: adding a currency is a relay code change through git review, live with the next `just up` — no canister step. The registry is easy to re-add if a governance handoff ever becomes real and would add value then.

## Non-negotiable: external claims are true, and vision is labelled as vision (set 2026-08-26)

Applies to every outward-facing artifact — investor email, pitch, deck, landing page, app-store copy, video script, demo narration.

- **Never invent the past.** No anecdote that did not happen, no user or merchant who does not exist, no traction that was not measured. A hypothetical, an illustration, or a sentence sitting in a draft is not evidence — never promote one to fact. Both failure modes are real and both happened while drafting the 2026-08-26 investor email: a fabricated "last week I paid for a coffee with it", and an example-of-a-lie ("I paid for a pizza with this") mistaken for a report of a real payment. When a claim about the past would strengthen an artifact, ask for the primary record; do not reconstruct it.
- **Never overstate the present.** A capability is described in the present tense only when it is verified against a primary source or a live run — the shipped build, a live endpoint, a green gate. "Built" is not "shipped", "wired" is not "proven", and a passing test is not a working product.
- **Vision is allowed, and is stated as vision.** "We don't have that yet, and here is where it goes" is honest and is what investors expect. The mechanism is tense: future/roadmap verbs for what is planned, present tense reserved for what is verified. Never blur the two inside one sentence.
- **A roadmap claim must be checked for feasibility before it is made.** Does the architecture allow it, do the non-negotiables permit it, does the dependency actually exist? An infeasible promise is a lie with a delay. Where feasibility is genuinely unknown, say that it is being explored.
- **Artifacts must not contradict each other.** Each one being individually true is not enough. When two disagree, find which is wrong and fix that one — never paper over it with a caveat.

## Non-negotiable: how Claude must be able to iterate

These are hard requirements, **not preferences**. Do not accept a design that violates them — restructure the design instead.

- Claude must run the **full dev cycle autonomously** — analyze UI, test, identify/debug, fix, verify the fix — with **no human in the loop**.
- It must run **locally and offline**: no network, no external services, no cloud on the inner loop.
- The inner dev/test cycle must complete **in seconds** (target < ~10s end to end).
- Money- and protocol-critical logic lives in a **strongly-typed Rust core** (`dpay-core`) shared by the canister, relay, phone app (via UniFFI Turbo Module), and a headless test harness — so the code Claude tests is the code that ships.
- Canister/ledger iteration uses **PocketIC** (in-process, deterministic, offline; `dfx` now defaults to it).
- The **Android emulator / physical device is a fidelity gate only** — never on the inner loop, by design. (This sandbox *does* now have `/dev/kvm` + the emulator, so `just ondevice` / `just app` run here — but they stay an outer-loop gate; the fast inner loop remains headless.) UI is verified headlessly (`react-native-web` + headless chromium screenshots).

Full plan and rationale: `dev-loop-plan.md`.

## Non-negotiable: "pre-existing" is not a reason to leave something broken (set 2026-09-08)

Founder rule, verbatim: **"'pre-existing' excuses don't work here, please fix all problems, not only
the ones you know you introduced! Make it a hard rule to do so."**

- A defect you find is a defect you fix, whoever wrote it and whenever it landed. "Not mine",
  "pre-dates this change", "out of scope", "another agent owns that file" and "the test was already
  red" are **not** dispositions. They are, at most, an explanation of why the fix is a separate
  commit.
- A gate that was already failing is worse than no gate, because it has been silently teaching
  everyone to ignore it. Fix the gate AND whatever it was failing on.
- The only legitimate reasons not to fix something on the spot: it needs a founder decision (say
  which), it needs an external step this repo cannot take (say which), or it is genuinely
  higher-effort than the session can hold — in which case it goes in `OPEN_ISSUES.md` with a value
  and an effort **and gets picked up next session**, not parked forever.
- When a subagent reports something as "not mine to fix", that is a hand-off to be routed, not a
  conclusion to be recorded. Route it.

## Non-negotiable: useful practical instructions on every step (set 2026-08-29)

Founder hard rule, verbatim: **"user MUST be given useful practical instructions on every step, especially error path. If you cannot figure out what the instructions should be, ask."**

- Every screen the user lands on — and especially every dead end, error, or gate — must tell the user concretely what to do next. A state that only describes itself ("not available yet — check back soon") is a bug.
- "Useful and practical" = the user can act on it with what's on screen: name the asset, name where it comes from (which wallet/network), show the address/QR to send to, state the fee, state what needs no memo/reference. Never a vague apology.
- This rule binds even when the honest answer is "this asset has no fiat ramp": receiving by plain on-chain transfer is still a complete, practical instruction (e.g. VCHF/ICP: send from any Internet Computer wallet to your own ICRC-1 account — QR + copy + fee shown, `IcrcDepositSheet`).
- If a step genuinely has no instruction that can be given (a true external blocker), surface that to the founder instead of shipping placeholder copy.

## Non-negotiable: the agent test float is REAL money (set 2026-09-01)

Claude holds a funded mainnet key so it can prove things that have no sandbox (the OpenCryptoPay
provider has none; the VCHF/ICP funded-transfer proof has none). Mechanism, recovery and the spend
log: `docs/AGENT-FUNDS.md`. The rules bind here because they must be in context every session.

- **Measure, never assume.** `just agent-balance` is the only statement of what the float holds. A
  balance from memory, from a doc, or from a previous session is not evidence. `UNREADABLE` is not
  zero.
- **Ceiling: CHF 25 equivalent.** Claude never asks for or accepts more than this in the float, and
  never tops it up itself. Everything below is affordable *because* of the cap.
- **Spend without asking only when ALL hold:** ≤ CHF 2 equivalent in one operation; the destination
  was validated by the core (`icp_validate_principal` / `icp_validate_icrc_account`); the purpose is
  a stated verification that cannot be done offline; and the spend is appended to the log in
  `docs/AGENT-FUNDS.md`.
- **Ask the founder first for:** anything above CHF 2, the first payment to any new counterparty
  (each new merchant/till counts), anything that would empty the float, and any spend whose outcome
  Claude cannot check afterwards.
- **Never:** sign anything Claude cannot explain in full; send to an address that failed core
  validation; reuse this seed as any other identity; put it in an APK, a screenshot, a test fixture,
  or a subagent prompt; or print the seed except immediately before an approved spend.
- **Report honestly.** A spend that bought nothing is a spend that bought nothing — record it. Do
  not spend again to "make it work" without asking.

## Projects

| Name | What |
|------|------|
| **dpay** | Consumer wallet with Venmo/Alipay-style UX for **instant payments that work offline**; settles on the Internet Computer (chain-key assets) and directly on Solana. Signature feature: the payer authorizes a payment **fully offline**; the online merchant submits it and gets a final confirmation in seconds. |
| **PoC demo** | Smallest build that proves the offline-pay / online-confirm flow for investors — Android RN app, Node relay, ICP canister ledger, two phones, ~60s airplane-mode demo. Everything else deferred. |

## Positioning (main pitch)

**Full doc: `positioning.md`. This is the primary go-to-market story — lead with it.** Summary:

- **Who:** travelers/tourists abroad on no or poor connectivity — foreign SIM, roaming off, or dead signal inside airports, malls, hotels, stadiums, metros.
- **What:** tap-to-pay (NFC) or scan-to-pay (QR) a local merchant; **your** phone never needs a connection.
- **Why it fits perfectly:** dpay lets the **payer** be offline, and the tourist *is* the payer. The design's one asymmetry (someone must be online) is satisfied for free — it's the merchant, who has wifi. The generic "both offline" weakness becomes the selling point.
- **Currencies — multi-*rail*, never a swap.** The merchant's request names the settlement asset; the payer pays that **exact** asset; the canister settles it. dpay never converts one asset to another (no-swap non-negotiable). If the payer lacks the merchant's asset, a third party or on-chain protocol converts at the edge — the user authorizes it directly, dpay stays a screen; delegated in-app conversion (user-device-signed, e.g. ICPSwap) is the landed 2026-09-07 founder direction, recipient/merchant-side first. **USDC is the tourist lingua franca** (no conversion at all). UI shows the **backing native currency symbol** when known (`$`, `€`, `CHF`, `₿`/BTC, `Ξ`/ETH, `◎`/SOL) and only falls back to the wrapper (`ck*`) symbol when the backing is unknown; raw internal ledger/token identifiers (e.g. `DEMO_USD`, `DUSD`, ledger canister ids) are never surfaced.
- **Assets (IC rows re-measured against prod `/api/v1/currencies` 2026-09-04):** live on IC = ckUSDC (launch rail), ckBTC, ckETH, plus native ICP + VCHF (deployed 2026-08-30; see What's built. VCHF is a direct ICRC ledger asset, NOT fiat CHF and not chain-key-backed). SOL = native device-key rail, **shipped** — mainnet RPC via the dpay relay's `/api/v1/solana/rpc` proxy since 2026-09-10 (provider key is deploy config, not in the app; no ckSOL on IC). Near-term = EUR via EURC (verify ckEURC). Nascent = CHF (no ckCHF; thin issuance). "Pay with BTC" = **ckBTC on the IC** (native L1 can't be tap-instant; IC finalizes in ~1–2s; SOL settles natively in ~1s).
- **Edge vs Apple Pay/Visa abroad:** their payer must be online *and* they add cross-border FX/interchange; dpay's payer is offline and same-asset settlement has no card-network FX toll.
- **Scope:** shipped = DEMO $ + mainnet ckBTC/ckUSDC/ckETH + VCHF + native ICP + the native SOL rail; multi-currency is the product. Nothing here weakens the non-custodial / no-swap non-negotiables.

## Terms

| Term | Meaning |
|------|---------|
| ICP | Internet Computer — the decentralized ledger dpay settles on |
| canister | ICP smart contract acting as the demo ledger (verifies sig, checks nonce/expiry/cap/balance, moves funds atomically, returns receipt) |
| relay | tiny Node/Express + `@dfinity/agent` service that submits the merchant's authorization to the canister; the **only online dependency** in the demo |
| authorization | signed payment payload binding `{from, to, amount, currency, nonce, expiry, names, memo}` that the payer builds and signs offline |
| nonce | per-payment value the merchant mints once; the payee's reconciliation handle on the shipped rail, and the ledger nonce on the facade/DEMO rail. What actually makes a replay settle once is the signed envelope's request id — `dpay_core::PaymentRequest` |
| offline payer | the phone that signs while in airplane mode |
| online merchant | the phone that scans + submits and shows "Paid ✓" |
| ckUSDC | chain-key USDC on ICP — the real stablecoin dpay would use off the internal demo ledger |
| backing symbol | the UI shows the asset's backing native currency symbol when known (`$`, `€`, `CHF`, BTC, ETH, SOL); falls back to the wrapper symbol (`ck*`) only when the backing is unknown. Raw ledger/token identifiers are never surfaced. |

## Current wallet UX direction (2026-08-01)

The next product milestone is an **asset-first wallet**, not a generic payer-side currency switch. The merchant chooses the exact settlement asset when creating a request; the payer reviews and pays that locked asset. dpay must never imply that choosing another balance will convert or substitute assets.

- **HARD RULE (founder, 2026-09-09): an element earns its place by adding value the surface does not already carry.** Verbatim: *"drop WORDS and sentences and generally UI elements that do not add clear value to the user."* Three specific failures to recognise, all of which shipped: a fact stated a second and third time (a green check disc, then `Paid ✓`, then a tilted `SETTLED` chip); a screen naming itself above a headline that already names it (`Review payment` over `Pay 0.51 ICP`); and **copy written for dpay rather than for the user** — a policy sentence like *"dpay doesn't convert"*, or a caveat the reader cannot act on, is a note-to-self on a payment screen. Attribution is still required where the no-quote rule demands it, but it is carried by naming the source (`CHF 1 · price from api.dfx.swiss`), not by a disclaimer. Warnings that only matter inside a window render only inside it. What the founder was reacting to and what came off each screen: the module headers of `app/components/OcpQuoteLines.tsx`, `app/components/PaymentReview.tsx` and the header block of `app/styles.ts`.
- **HARD RULE (now and for the future): every currency is handled through the SAME UI surfaces and flows.** IC assets and SOL share one wallet information architecture — the same Balances list + select, the same Pay/Receive tab structure, the same deposit/withdraw entry points, the same toggles. A per-currency or per-rail special case in the wallet IA (e.g. a Send/Receive button that exists on one rail's Balances row but not another's, a sheet reachable for one family but not others, a toggle that appears for one asset and not the rest) is a **bug, not an exception**. When a new rail is added, it slots into the existing surfaces; it does NOT get its own parallel path. Divergence is allowed only where a capability is *physically impossible* for a rail (e.g. SOL has no IC-relay request-payment flow) — and even then the entry-point shape stays uniform (the user lands on the same tab/toggle, just with the unsupported branch failing closed and explained honestly). This supersedes the temporary SOL-as-exception in the 2026-08-09 IA refactor; the SOL parity follow-up is tracked in `OPEN_ISSUES.md`.
- Every enabled payment asset is visible in the wallet, including zero-balance assets and assets without a direct ramp. The demo-dollar rail is clearly separated from real assets. Do not hide the catalog behind a positive-balance condition.
- Selecting an asset opens an asset detail/action surface with the actions actually supported for that asset: Pay, Request, Add money, and Cash out. Funding and cash-out capabilities are independently `Direct`, `Partner`, or `Unavailable`; unsupported actions fail closed and are explained honestly. **(2026-08-09 IA refactor)** the on-chain Add money (deposit address) + Cash out (withdraw) moved OUT of the Balances per-row buttons and INTO the existing Pay/Receive tabs: the Receive tab has a `[ Request payment | My address ]` toggle (My address = the on-chain deposit flow for the active asset's family), and the Pay tab has a `[ Scan to pay | Send to address ]` toggle (Send to address = the on-chain withdraw). Balances is now a pure balance-list + select screen (whole-row select, active-only border). Precedent: SOL already inlines its modes. The "Receive" label is kept (NO rename to "Deposit"). DEMO hides the toggle (no on-chain family).
- Request creation requires an asset selection and encodes that runtime currency ID. Payment review shows the exact requested asset and checks only that asset's balance. The payer cannot switch the request to another asset.
- **Ledger is a dedicated page**, not an inline card below Pay/Receive. It shows mixed-asset activity with the correct unit on every row and supports asset filtering as the list grows.
- Remove the prominent **Paste request** action from the main Pay UI. Retain it only as a secondary scanner fallback (for no-camera/desktop/support use) if that path has a real user need; otherwise remove the feature and its tests rather than leaving zombie chrome.
- Settings belongs in a recognizable navigation-level control (for example a 44pt header account/settings button or overflow), not a detached footer bar. Consumer settings come first; relay URL and other operator configuration are clearly marked advanced. Relay edits are applied explicitly, not on every keystroke.
- Do not show a synthetic portfolio total across unlike assets unless a clearly informational quote source is deliberately introduced. dpay does not quote or perform conversion.

## Architecture (PoC)

- **Mobile app** — one React Native app (Android only), Pay + Receive modes; on-device key; QR generate/scan; builds & **signs the authorization fully offline**.
- **Relay** — Node + Express + `@dfinity/agent`; receives merchant submission, calls canister; small idempotency store (in-memory is fine for the demo).
- **Canister (ICP)** — Motoko or Rust (`ed25519-dalek`); verifies Ed25519 sig, checks nonce unused/unexpired, checks amount within balance and cap, atomic transfer, records nonce, returns receipt. Two accounts pre-funded at init.

## Payment flow (decided): two-scan, amount-bound

1. **Merchant (online)** selects the exact settlement asset and shows a request QR binding `{to, amount, currency, request_id, expiry, to_name, memo}`.
2. **Payer (offline)** scans it, reviews "Pay <amount> <asset> to <merchant>" against that asset's balance, approves → signs the complete authorization → shows a signed-auth QR.
3. **Merchant** scans the signed-auth QR → submits via relay → canister verifies sig + nonce/expiry/cap/balance, settles atomically → "Paid ✓".

The signature binds the **exact amount + payee + request**, so consent is unambiguous. No double-charge on a replay, but note the mechanism: on the shipped app-signed rail the merchant-issued `request_id` is NOT a ledger nonce (it rides as the ICRC memo, a reconciliation handle) — the payer signs one envelope and the IC admits that envelope's request id once, so the same bytes handed over twice settle once. It IS the ledger nonce on the facade/DEMO rail. Per-rail truth: `dpay_core::PaymentRequest`. Short `expiry` (~5 min) kills stale replays. Rejected: single-scan payer-presented pre-auth (merchant fills the amount) — faster but weaker consent. Deferred: a signed receipt QR back to the payer for offline confirmation.

## Non-negotiable: dpay never holds, swaps, or can move user funds

Hard requirement, **not a preference**. Reject any design that violates it — restructure instead. This is a product rule and stands as one. The legal conclusion previously attached to it here was too strong and is deleted — see `docs/REGULATORY.md`.

- **No custody.** The user's key lives on their device. dpay (the company, the relay, any operator) must never hold a user seed, an omnibus account, or funds it can move.
- **No swaps by dpay.** dpay does not exchange one asset for another as counterparty, and does not take price risk. **Delegated conversion is a founder-set product direction (2026-09-07):** integrate existing DeFi and CeFi venues so the user can convert quickly — the user's OWN device signs directly with the venue/protocol (e.g. `icrc2_approve` + ICPSwap pool swap; CeFi: the user authorizes the provider directly), recipient/merchant-side first; dpay is never a party to the trade (spec: `docs/specs/2026-09-07-delegated-conversion-spec.md`). Red lines: the venue's own quote shown attributed + timestamped (never computed/blended/ranked), no dpay cut, funds never touch a dpay-controlled address. Multi-venue since 2026-09-11: several venues may sit on ONE pair, rendered side-by-side in stable quote-independent order with none preselected — the user picks; there is still no ranking, no blending, no routing surface (spec: `docs/specs/2026-09-08-multi-venue-readiness.md`). Wider quote/routing/cut questions stay open — `monetization.md`, `docs/REGULATORY.md` §7.
- **No exchange API keys.** dpay must never hold a user's CEX/DEX credentials and must never initiate a trade or withdrawal on a user's account. Holding withdrawal-capable credentials *is* control, and control *is* custody — same liability, plus a credential honeypot. If a third party must move funds, the **user** authorizes it directly with that third party.
- **The canister cannot move funds without a user signature.** No admin transfer, no pause-and-seize, no privileged path. And the controller must not be a company key — blackhole it or hand it to an NNS/SNS-governed controller, or the "we can't touch your funds" claim is a promise rather than a property. Treat "who controls the canister" as a money-critical design question, not ops trivia.

## Funding (on/off-ramp) — the shape

**`FUNDING.md`** — the Add money / Cash out shape, the direct-vs-partner split, and a one-owner pointer table for every rail's mechanism. The user always ends up holding the asset at **their own principal**; dpay is a screen, not a counterparty. Crypto deposit and withdraw are BUILT on every family; the FIAT ramp is what remains deferred (see Scope, above).

(The summary that used to sit here was deleted 2026-09-04, for the same reason the monetization one was: it had drifted into a custody model the code abandoned at the 2026-08-19/20 cutover, and carried a "verify before promising it" note on a SOL rail that has since shipped. Pointer only — do not re-summarize it here.)

## Monetization — direction

**`monetization.md`** — read it before touching anything fee-, badge-, or merchant-account-related. None of it is in the PoC.

(The summary that used to sit here was deleted 2026-08-26: it had already drifted out of date against the source doc, which is exactly what the DRY rule predicts. Pointer only — do not re-summarize it here.)

## Local dev cache & offline (`third_party/`)

Claude and all subagents treat `third_party/` as the canonical local source cache — **look there first; clone any missing repo there (shallow) instead of re-fetching from the network.** Crates are vendored to `vendor/` (`cargo vendor`); the PocketIC **server** binary lives at `third_party/bin/pocket-ic` (v14.0.0) and is referenced via `POCKET_IC_BIN`. The Rust + Node toolchains and a vendored headless browser (`chrome-headless-shell`, because the sandbox's `/usr/bin/chromium-browser` is a non-functional snap stub) install under `.dev/` (kept in-project because the sandbox recycles `$HOME`, so this keeps iteration fast across sessions). `.dev/`, `third_party/`, `vendor/`, and `target/` are gitignored. Inner-loop builds/tests run fully offline against these.

## What's built (offline-first via `just`; current red/false-confidence gates are tracked in `OPEN_ISSUES.md`)

- **dpay-core** — signing/verify/validate/QR codec, proptests incl. conservation-of-funds + tamper; compiles to wasm with `getrandom` gated out.
  - `nfc` module — pure, panic-free ISO 7816-4/ISO-DEP protocol v2. The merchant sends the 132-byte request with a certified short IC expiry; the offline payer returns a DPN2 bundle containing the immutable signed update and reusable payer-signed `request_status` read_state envelope. The merchant alone submits/polls, requires exact ledger history before claiming settlement, signs a nonce+request-ID result, and returns it over C6 (or a result-only re-tap). Because read_state trees are not yet BLS-verified on-device, a status rejection without exact history is returned as honest unknown, never a false decline. The payer verifies the merchant result signature against the key in the request. Expiry stops new taps but never tears down an active result-return session. NFC therefore works with the payer in airplane mode and has one settlement owner.
- **dpay-canister** — ic-cdk ledger; PocketIC tests (happy/nonce/expiry/cap/insufficient). Facade over external ICRC ledgers: the currency registry is REMOVED (founder decision 2026-08-28 — the relay is the sole catalog authority); currency resolution is the `demo_ledger` init arg (DEMO 0) + compile-time ck ledger/minter consts (ckBTC 1, ckUSDC 2, ckETH 6). Keeps pay/mint/burn/faucet/balance_of/withdraw (family dispatch)/deposit_info/deposit_address/receipts/reconcile + staging provisioning; init arg is now `record { demo_ledger; per_tx_cap; controller }`.
- **dpay-relay** — axum; read-only config/display surfaces (the compiled-in currency catalog — `crates/dpay-relay/src/catalog.rs`, the SOLE catalog authority since the 2026-08-28 registry removal, served in all modes and drift-alarmed against `dfx/catalog_truth.json`; history, deposit info, ckERC20 onramp params) + batch balances fanned out as direct `icrc1_balance_of` queries at user principals, `/health`/`/version`, the offline web wallet at `/wallet`, and APK/shot hosting. Settlement left the relay entirely (2026-08-19): payments are app-signed IC `/api/v2` envelopes — no `/pay`, no settlement `Ledger` trait. `FakeLedger` (inner loop; faucet sugar over the `test-helpers` in-process fake-IC `/api/v2` gateway) + `AgentLedger` (feature `agent`: read-only queries against the live facade).
- **dpay-sim** — narrated end-to-end demo (offline sign → canister → Paid ✓ → double-spend refused → expired refused). GREEN: runs the full offline-sign → canister-settle → idempotency → expiry flow against the REAL canister wasm on PocketIC over the REAL `ic-icrc1-ledger` (the facade delegates `pay`/`balance_of` to the `demo_ledger` ICRC ledger; the payer is funded via the self-service `faucet` — the 2026-08-20 `mint` re-target to user principals had broken the old controller-gated-mint funding, and the faucet fix landed with the 2026-08-28 registry removal). `just sim` self-checks every balance (9500/500 cents), so it doubles as an end-to-end test.
- **dpay-ffi** — UniFFI wrapper; a Python roundtrip proves the app calls the exact compiled core; Kotlin binding emitted for Android. It exports DPN2/result codecs and card/reader state machines plus the `icp_*` signing/request-ID/DIDL surface.
- **e2e/** — drives the real `app/App.tsx` in react-native-web against the offline in-process fake-IC gateway. It covers app-signed envelope submission/read_state, request-ID dedup, receiver-side nonce-bound history confirmation, deposits/offramps, both IC NFC v2 ownership halves (merchant-only settlement and offline-payer result completion), deeplinks, SOL, accessibility, and visual regression.
- **VCHF + native ICP — complete first-class IC assets (spec `docs/specs/2026-08-28-vchf-icp-support-spec.md`, 2026-08-28; deployed and live — see the DEPLOYED note at the end of this bullet).** Catalog ids 7 (VCHF, ledger `ly36x-wiaaa-aaaai-aqj7q-cai`) / 8 (ICP, ledger `ryjl3-tyaaa-aaaaa-aaaba-cai`), 8-decimal raw units, mainnet `Internet Computer` rows in both the bundled app catalog and the relay's compiled catalog (sole authority since the 2026-08-28 registry removal — there is NO registration step anymore), drift alarms on both sides pinned to `dfx/catalog_truth.json`. Payment is an app-signed direct `icrc1_transfer` to the exact ledger (no minter, no facade value call); `isPayableAsset` is decoupled from ramps, and both rows are `onramp = offramp = Unavailable` so no Add money / Cash out actions render while Pay/Receive work — and since 2026-08-29 the zero-balance fund gate + Receive ▸ My address carry REAL top-up instructions (`IcrcDepositSheet`): the user's own ICRC-1 principal as QR + copy, send-from-any-IC-wallet, no memo needed, ledger fee shown — a plain `icrc1_transfer` in, no ramp required (founder hard rule 2026-08-29: useful practical instructions on every step; relay catalog rows stay `onramp=Unavailable` — that is fiat-ramp honesty, not a transfer-in blocker). The ck\* family sheets carry the same route (2026-08-29, founder follow-up): a shared `IcrcAccountSection` "Already on the Internet Computer?" on the ckBTC and ckETH/ckUSDC deposit surfaces shows the wallet's ICRC-1 principal too — funds already on the IC transfer straight in, no Ethereum/BTC round trip, and each sheet's existing ledger watch credits it as a normal delta; the section names the LEDGER token (`wrapper_name` — ckBTC/ckUSDC/ckETH), never the display glyph, since plain BTC/ETH cannot be sent to an IC principal. Native ICP history runs through the official ICP index `qhbym-qaaaa-aaaaa-aaafq-cai`, hard-pinned in the relay's `agent_ledger.rs` adapter (exact-principal dispatch; `icrc1_memo`-hex-only reconciliation). Verified: `just verify` EXIT=0 (96/96 e2e incl. 7 new flows 95–101), jest 1160/1160, `just test-relay` 44/44, `just test-live` 62/62, `just ic-index-probe` PASS vs mainnet, emulator device gates green (self-check + offline cold start renders both rows). DEPLOYED 2026-08-30 (`just apk && just up`) and verified live: `/api/v1/currencies` serves both mainnet rows (VCHF ledger `ly36x…`, ICP ledger `ryjl3…`, decimals 8, fee 10_000). The funded mainnet transfer proof is CLOSED (founder, 2026-09-01): a real VCHF round trip on a physical device with real funds — so production payment completeness IS claimed for these assets. ICPSwap buy/sell is NOT included — separate future spec, no automatic conversion.

- **Payment links — the ONE shareable "pay me" URL (2026-08-29, founder decisions this session).**
  `https://dpay.kalaj.org/wallet/pay/<recipient>?asset=…&network=…&amount=…[&label=&memo=&ref=]` —
  readable and hand-authorable, the shape BIP-21 / Solana Pay established, mapped onto https so ONE
  string is both an Android App Link (opens the app) and a plain web link (opens `/wallet`). It
  REPLACED the opaque `dpay:req/<blob>` + `?req=` mirror (one URL format, not two); the 132-byte
  binary wire stays for QR/NFC, and the `dpay:pay/` receipt hand-back is unchanged. `network` is
  REQUIRED and names the SETTLEMENT chain (`internet-computer` | `solana`) — the founder's call, and
  the thing that separates ckUSDC-on-IC from USDC-on-Solana from USDC-on-Ethereum; a right-token /
  wrong-chain link is REFUSED, never redirected. Both rails, same grammar: IC → a pre-filled review
  the payer must Approve (paying ANY ICRC-1 principal, not just dpay users — `prepareTransfer` now
  takes the destination principal, derived from the pubkey on the wire path); SOL → the pre-filled
  Send-to-address form. A link NEVER auto-signs, always shows the FULL destination account, marks
  the sender-given label as claimed, and carries no expiry (the envelope's IC ingress expiry still
  bounds signing). `ref` = the on-chain memo: present ⇒ one invoice, in the sense that every
  payment of the link carries the same memo for the payee's request screen to reconcile — NOT that
  a second payment is refused, because dpay sends no `created_at_time` and an ICRC-1 ledger
  deduplicates nothing without it (rule + reasoning: `icp_transfer_arg` in `crates/dpay-ffi`);
  absent ⇒ a reusable link. Every refusal names the asset/chain
  and the payer's next action (founder rule). Authority for the grammar + trust model: the module
  header of `app/lib/deepLink.ts`; asset/amount resolution: `resolvePayLink` in `app/config/assets.ts`.
  New core export `icp_validate_principal` (FFI + wasm + Kotlin) CRC-validates a link's destination
  before the payer sees it. Relay serves `/wallet/pay/{recipient}` + `/.well-known/assetlinks.json`
  (all four project signing certs, incl. the upload key so sideloaded builds verify too). Verified:
  `just verify` EXIT=0 (98/98 e2e incl. new flows 102/103), jest 1203/1203, `just test-relay` 47/47,
  emulator device gate green + the link driven on-device (review + refusal screenshots). **Android
  App Links are LIVE and verified end-to-end on physical hardware (2026-08-30):** prod serves
  assetlinks.json (HTTP 200, all 4 certs), the phone reports `dpay.kalaj.org: verified`, and a real
  `…/wallet/pay/…` link opens the app straight onto the pre-filled review — no browser, no chooser.
  **The till code is an App Link too (2026-09-12):** the relay's ring-up QR
  `https://dpay.kalaj.org/pl/?lightning=…` is claimed by a second manifest `autoVerify` filter
  (`pathPrefix="/pl/"`) — a dpay-installed phone opens the payer straight onto the OpenCryptoPay
  review (the SAME classification a camera scan takes; explicit Approve, never auto-signs), while a
   generic camera still gets the relay's `/pl/` landing page. assetlinks.json is host-wide, so the
   relay needed no change; e2e flow 175 pins both rails. **The dpay REQUEST QR is a payment link
   too (founder decision 2026-09-12, reversing the same-day fork the other way):** every
   payment-request QR the wallet renders is the `…/wallet/pay/…` URL itself, on every rail — a
   regular phone camera opens dpay or the web wallet; the machine codes (IC 132-byte wire, SOL
   `solreq:v2`) survive only on the radio/confirm paths (NFC, payer signed-QR scan-back). Tradeoff:
   IC dpay→dpay camera payment = review + Approve instead of wire auto-sign, and the open request
   screen now polls the rail at `POLL.request` cadence — the link's `ref` is the request nonce is
   the on-chain memo, so a camera-scanned link payment flips the screen to Received with no second
   radio hop (e2e flow 176). SOL links carry `ref: null` (the rail attaches no reconciliation
   memo) — a SOL link payment shows on balances/transactions but does NOT auto-confirm the request
   screen, which still confirms via NFC/scan-back, matching SOL share-link semantics. Links are
   durable by design and stay payable after the screen's expiry countdown lapses.

- **Send to an external address — ONE destination field, routed by what you paste (2026-08-30).**
  Pay ▸ *Send to address* now renders for every asset that can leave the wallet, not just the
  chain-key families. VCHF/ICP previously had NO send path at all (the toggle was gated on a minter
  family) while the Receive tab already handled them — the asymmetry this closes. Paste or **scan**
  a destination; `app/lib/destination.ts` classifies it by address NAMESPACE and the route decides
  the rail: an IC account → `icrc1_transfer` on the asset's own ledger (so ckBTC reaches an Internet
  Computer wallet without a Bitcoin round trip — the outbound half of the "Already on the Internet
  Computer?" deposit route); a 64-hex ICP **account identifier** → the ICP ledger's legacy
  `transfer` (ICP-ledger-only — that method exists nowhere else); a native address → the existing
  chain-key burn, delegated to `WithdrawSheet` with its double-burn resume intact. The route, its
  speed and its fee are disclosed BEFORE the amount is entered; refusals name what the address IS
  and what to do instead (founder rule 2026-08-29). Max subtracts the fee; an unregistered fee is
  shown as "set by the ledger", never as 0; **paying your own account warns and never blocks, on
  every path** — this one, a pay link naming your own principal, and your own request QR scanned
  back (one sentence, rendered by `PayeeLine`; it was here alone until 2026-09-09). **The account shown is the
  account signed (fixed 2026-09-04, `e5d43ac`):** an `owner-checksum.subaccount` destination used to
  be displayed, saved and receipted in full and then paid to the owner's DEFAULT subaccount —
  `prepareTransfer` now parses owner + subaccount out of the one string the screen rendered. One
  destination is refused rather than paid: another subaccount of the wallet's OWN principal, because
  dpay reads exactly one account per asset (owner + default subaccount) and signs every transfer with
  an empty `from_subaccount`, so anything parked there would be invisible and unspendable here.
  Address book replaces the single last-used slot (`app/services/addressBook.ts`, per-asset, MRU,
  capped at 10). Core adds
  `Account::from_text` (ICRC-1 textual accounts incl. subaccounts, spec-canonical only),
  `AccountIdentifier`, and the legacy `transfer` arg/reply codec — all golden-pinned against the ICP
  ledger's own published IDL through `@dfinity/candid`. **Terminology checked against DFINITY's
  primary sources:** the `transfer` METHOD is documented as "legacy" by DFINITY; the 64-hex address
  form is NOT deprecated (it is what exchanges require and what `icp-cli` emits by default), so user
  copy calls it an *account identifier*. Verified: e2e 102/102 (new flows 104-107), jest 67
  suites/1244, dpay-relay 49/49, dpay-icp 40+27, emulator device gate + `just campreview` green.

- **OpenCryptoPay — dpay pays a merchant till, and now SERVES one (2026-09-01 → 2026-09-04).** A shop
  rings a price up in francs on its own dpay phone, shows a code, and is paid VCHF at its OWN
  account; the relay is the provider endpoint and never holds a key that could move that money.
  **The till ships ON: its eight routes register unless `DPAY_ENABLE_TILL=false` is set — the
  default flipped true on every build and every ledger by founder decision 2026-09-10, reversing
  the 2026-09-04 opt-in that predated the signed ring-up** (an operator can still un-serve the
  surface per deploy). A ring-up, and a cancellation, must be SIGNED by the key whose account gets paid
  (`dpay_core::validate_till_open`, domain `dpay-till-open-v1`, bytes pinned by
  `dfx/till_open_signing.json`). The counter sits inside Receive ▸ Request payment on every asset
  and arms the NFC reader with the charge's own reference, so a TAP pays the same charge a scan
  would — no new AID, no protocol change. Authority, each for its own half and none of it restated
  here: `crates/dpay-relay/src/till.rs`, `app/services/till.ts`, `app/components/TillCharge.tsx`,
  and `app/lib/opencryptopay.ts` for the payer side; founder decisions
  `docs/specs/2026-09-02-merchant-side-plan.md`; measured provider behaviour
  `docs/specs/2026-09-01-opencryptopay-findings.md`.
  **Who has been MEASURED paying a dpay till: a dpay wallet, and only a dpay wallet.** No wallet on
  the standard's own compatibility list settles any Internet Computer asset (measured twice — the
  findings doc). Oisy is the one wallet whose source carries an IC leg, and 2026-09-12 removed both
  things that stopped it: the provider routes now answer a browser (CORS), and the till now COLLECTS
  the ICRC-2 allowance such a wallet grants instead of refusing it — the MERCHANT's phone signs that
  `icrc2_transfer_from`, never the relay, which still holds no key. Proven offline end to end (flow
  177) and **never driven against Oisy itself**, whose scanner sits behind Internet Identity. So it
  is a capability, not traction: **never put third-party wallet reach in a deck, a demo script, a
  video or an investor email.** State the asymmetry exactly: a dpay payer can be OFFLINE over NFC or
  QR, and an OpenCryptoPay payer cannot — that standard makes its payer fetch the quote, fetch the
  destination and report the proof over https.
  Verified at `702c359`: `just verify` EXIT=0 with 112/112 e2e (flows 113–117), `just test-relay`
  88/88, `just test-live` 106/106, jest 83 suites/1682, `just ondevice` 10/10 and `just app` green on
  the emulator. **Live provider acceptance proved 2026-09-05, both tx-id spellings:** a freshly
  built physical-device app paid DFX Shop order `2609` in native ICP (official-ledger block
  `38190401`, bare index) and order `2610` in VCHF (block `81062`, submitted prefixed
  `ly36x-…-cai:81062`); DFX `/tx` accepted both and both shop orders completed. Remaining hardware
  proofs and what production is actually serving: `OPEN_ISSUES.md`.

**Device gate — now built and runnable in-sandbox** (this environment has `/dev/kvm`, the Android SDK/NDK, an x86_64 emulator, and `dfx`; see [[sandbox-can-run-device-gate]]):
- **real dfx deploy** (`just deploy`, `scripts/dfx-deploy.sh`) — a live local replica settles the *exact* offline-signed 292-byte wire via `dfx canister call` (built by `dpay-fixture` from the shared core); funds move, replay refused. `dfx.json` + extracted candid in `dfx/`.
- **NDK build** (`just ndk`, `scripts/ndk-build-ffi.sh`) — `libdpay_ffi.so` for arm64-v8a + x86_64, **16 KB-page-aligned** (Android 15 / Play); auto-detects the newest installed NDK.
- **on-device core** (`just ondevice`) — instrumented tests drive request→fragmented DPN2 bundle→merchant-signed result through the real UniFFI binding, including result-only SELECT/C6, signature verification, Complete phases, byte integrity, and request-ID parity.
- **NFC HCE glue** (in `app/android/.../com/dpay/`) — the merchant pushes the request, the payer signs both immutable envelopes without network access, and the merchant owns submission/polling. Android keeps the result channel alive for a bounded wait and supports re-tapping only to deliver the already-signed result. No blocking callback queue and no second settlement owner.
- **RN app** (`just app`, `app/`) — React Native 0.86 Pay/Receive app; a Kotlin native module (`DpayCoreModule`) bridges JS → the UniFFI binding → `libdpay_ffi.so`, so the phone signs offline with the real core. **Modular tree** (split 2026-07-31): `app/App.tsx` (the root: identity/relay load + self-check + `Onboarding|Wallet` route) over `app/{config,lib,hooks,services,i18n,solana,styles.ts,components}` (see `docs/specs/2026-07-31-app-split-plan.md`). Runs on the emulator; a logcat self-check + tap-driven Pay→Approve→Paid✓ screenshots (`app/shots/`) prove it end to end. (Pragmatic bridge module chosen over `uniffi-bindgen-react-native`; see [[device-gate-shipped]].) The **Pay screen** shows an NFC status row (`NfcIcon` + label — green when ready, red with a reason popup when not) fed by a native `DpayCore.nfcStatus()` reading the real `NfcAdapter` (radio on/off/absent; degrades to a hidden 'unknown'); `android.permission.NFC` + optional `uses-feature` added. **NFC + QR run concurrently with no per-payment toggle**: when the radio is ready the Pay screen keeps the HCE card armed *and* the QR scanner live at once (payer taps OR scans), and the Receive screen runs reader mode in the background while the request QR is shown (`NfcTap` renders nothing until a real tap starts, then takes over). The live tap phase (spinner/success/declined/error) comes from `DpayNfcEvent`s.

Recipes: `just verify` (core+canister+relay+e2e), `just test-live` (relay↔live canister via ic-agent), `just ffi` (UniFFI), `just sim` (demo), `just deploy` / `just ndk` / `just ondevice` / `just app` (device gate), `just apk` (signed APK+AAB), `just play-upload` (verify + exact signed AAB upload to Play internal testing; one-time credentials documented in `app/android/app/play-signing/README.md`). (The old `just ui` parallel-component harness is removed — `just e2e` drives the real app + screenshots every flow state.) Pinned: ic-cdk 0.19, pocket-ic 14.0.0, ic-agent 0.48.1, uniffi 0.29.5, dfx 0.32.0, RN 0.86.2 (AGP 8.12.0 from the bundled `@react-native/gradle-plugin`; New Arch enabled), Gradle 8.13, Kotlin 2.1.20, compile/target SDK 36, build-tools 36.1.0, AGP 8.7.3 for the standalone `android/` device gate, NDK 27.3.13750724, Gradle Play Publisher 3.13.0 (release path only).

The IC rail is proven on two physical phones (2026-08-26): the **NFC radio hop** (HCE↔reader), the payer's airplane-mode gesture, and the real-camera QR scan all work. Two taps have never crossed a radio: the SOL rail's independent HCE transport, and the till counter arming that IC reader from a live charge. Both are tracked as physical gates in `OPEN_ISSUES.md`.

## Scope

- **In:** Android app (Pay + Receive), on-device key, QR generate/scan, offline signing, relay, canister ledger, two pre-funded demo accounts, single `$` unit, the airplane-mode flow.
- **Out (deferred):** iOS, login/KYC, **fiat** on/off-ramp, secure-element hardening (the seed lives in plain AsyncStorage under `dpay.identity.v1`), contacts/P2P discovery, multi-merchant. Software keys are fine for the demo. (Corrected 2026-09-04: "funding flow" and "real onboarding" were still listed here while "What's built" above documents both — crypto deposit/withdraw on every family, and a name→backup→walkthrough first run. The FIAT ramp is what remains deferred.)
- **Out (permanently, by design — not "later"):** custody of user funds, dpay-executed exchange (dpay itself as swap counterparty or price-taker), holding user exchange credentials, taking price risk. Delegated, user-signed conversion through integrated venues is IN scope (founder 2026-09-07) — see the non-negotiable above; what stays permanently out is dpay *performing* the exchange.

## Preferences

- Be concise and direct; minimal formatting, no filler.
- Money is shown using the asset's **backing native currency symbol** when known (`$`, `€`, `CHF`, BTC, ETH, SOL); fall back to the wrapper symbol (`ck*`) only when the backing is unknown. Never surface raw internal ledger/token identifiers.
- Demo-critical: the relay must be rock solid (idempotency, retries, health check, safe-mode fallback).
