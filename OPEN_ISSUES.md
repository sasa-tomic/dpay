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
> new "pre-existing is not a disposition" bar were worked and REMOVED, not re-annotated: the checkout
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

**State — not issues (recorded 2026-09-20; no action without the founder):**

- **ChangeNOW verified live (2026-09-21): no ICP in the API catalog.** The partner key is
  sops-encrypted (`secrets/changenow.sops.json`, header `x-changenow-api-key`, v2 base
  `https://api.changenow.io/v2`); the key-authenticated catalog (1281 entries) lists
  `usdc@sol` and `eurc@sol` (both `supportsFixedRate: true`) but `icp` is ABSENT — the site's
  ICP hub page is not backed by the API. ChangeNOW is therefore NOT an ICP-bridge candidate;
  it remains an optional EUR↔USD-on-Solana redundancy rail (adapter unstarted). Final probe:
  the v2 estimate endpoint rejects `sol→icp` outright (`"Currency sol is not supported"`) —
  the site page renders off their internal surface, not the partner API. ChangeNOW support
  confirmed it definitively (2026-09-21): ICP is not integrated in-house; the website renders
  it via external "backup liquidity providers" while the API only carries in-house assets
  (they also corrected the param naming: `fromNetwork` takes `sol`, not `solana`).
  Follow-up (2026-09-21): ChangeNOW confirmed they have **no plans to add ICP support in the
  near future** — the door is closed, not just slow; revisit only if they ship it.
- **StealthEX verified live (2026-09-21): DISQUALIFIED as an ICP-bridge candidate.** The
  partner key is sops-encrypted (`secrets/stealthex.sops.json`, Bearer auth, v4 base
  `https://api.stealthex.io`); `icp/mainnet` IS listed (fixed + floating) but the decisive
  v4 estimate probe returns `NoPair — one or both currencies do not exist` for every needed
  direction (icp↔sol, icp↔usdc@sol, icp↔eurc@sol, both ways) — the site's ICP↔SOL pair page
  is not backed by the partner API. Its schema remains the best adapter template in the class
  (`refund_address` at create, network-aware routes, fixed+floating with `rate_id`).
- **SideShift return shift: EURC→ICP leg DONE 2026-09-22 (attempt #9).** The stale-ok gate, the skipPreflight broadcast posture (817954d), and the destination byte-length classifier all live-proven in one session; shift `d61b2eec59d5e5d45d6b` settled 3.34293257 ICP against the 8.8 EURC deposit (independent ICRC-1 read: float ICP now 3.39528652), reconcile CLEAN, ledger rows 138–144. Full disposition under the closed entry below — nothing pending on this leg.
- **Convert settle-probe budget parks records on `stuck` under real prod latency (2026-09-27
  live finding; value 5 / effort S) — FIXED same day.** The flagship leg-1 ICPSwap swap settled ON-CHAIN at
  ~+11 s (ICP block 38641313 -> VCHF payout 82188) while the app had already parked the record
  on `stuck` at ~+9 s. The honest-unknown design held exactly as specced (no false done, the
  correct "do not start a second swap" guidance, funds never at risk, the record flips on its
  own), but a real boundary-node round trip under host contention beats the probe budget, and
  the user eats a scary unknown for a swap that settles. Fix (this commit): the direct record's
  swap-unknown arm now runs the SAME pre-park ledger watch the expired arm always ran — a late
  payout flips done in the driver (~+13 s in the live shape); a silent ledger still exhausts
  into the same honest unknown, now actually probed. Pinned both ways in convert.test.ts
  (silent → stuck with probes asserted; payout-during-watch → done, never stuck). Related
  verification gap: the stuck -> done reopen flip has never been observed live on web (the
  observing session died first); it is e2e-covered offline only.
- **SideShift REVERSE leg: ICP→EURC DONE 2026-09-22 (attempt #10).** The registered-until-now-unexercised `sideshift-eurc` ICP-deposit direction is live-proven end to end: order created first-press in the real app (the IC-side destination GROUP is the composed route row `convert-dest-route-multihop:…:jupiter-usdc-eurc` — the cefi venue MERGES under it as mechanism `convert-dest-mech-sideshift-eurc`, D4); settle address verified on the surface BEFORE confirm = census EURC ATA owner `BzFNJ…` verbatim; refund = the float's own 64-hex identifier `9fac39d1…2279` verbatim in the venue shift object. Shift `c3644b54ba21a36dabd8`: 3.38 ICP (venue min 3.3384 at probe), rate 2.581167159763 locked at creation, deposit broadcast 22:40:25Z (ICP block 38520213, the app's IC send sheet), venue settle transfer `sol:5uqg3tu…tcB8a` hit the ATA 22:41:02Z — **SETTLED ~37 s after broadcast** (the venue watches the IC ledger directly). Independent on-chain read: EURC ATA 0.474071 → **9.198416** = +8.724345 = the order settleAmount EXACTLY; float ICP 3.39528652 → 0.01518652 = −3.3801 (deposit + 0.0001 ledger fee). Reconcile 18 pairs CLEAN, ledger rows 145–147. The EUR rail is now a PROVEN TWO-WAY bridge on both legs; nothing pending on this leg.
- **Route-B / CCTP USD leg (2026-09-21, cctp-live session): live-driven; the ckERC20 withdraw
  FAILED-and-was-refunded — value recovered, cause uninvestigated.** Real-app legs that worked:
  ckBTC→ckETH probe swap (pool akhru: 0.0000096 + 2×0.0000001 fees → 0.000291876642414143
  ckETH) and the fuel swap — the DIRECT VCHF/ckUSDC pool hx7nb, single swap, no ICP hop
  (0.1445 VCHF + 2×0.0001 fees → 0.167977 ckUSDC). The withdraw of 0.158587 ckUSDC → evm-float
  0x6B1C…83b9: attempt #1 paid its approve fees (0.000002 ckETH + 0.01 ckUSDC), the ckETH minter
  gas-burned 0.00013176308327 ckETH then minted it back minus the 2e12 ledger fee ~3 min later —
  it aborted BEFORE pulling the ckUSDC (ckUSDC never left; allowance unspent); attempt #2 halted
  at REVIEW, no burn. Attempt #3 (send-usdc rounds 12–15) paid a third approve pair at 13:20 UTC
  (allowances 0.00018052378682 ckETH + 0.1385 ckUSDC to the ckETH minter) and failed at the
  withdraw form. ARBITRATED 2026-09-21 (reconcile vs MEASURED): attempt #3's allowances were
  NOT live-unspent — tokens LEFT the float in exactly the allowance amounts (0.1385 ckUSDC
  pulled + a net 0.000179157567210 ckETH kept, corrections rows 95–96); the earlier "no minter
  burn" reading was wrong for #3. WHERE the 0.1385 ckUSDC sits now is UNVERIFIED (evm-float
  `0x6B1C…83b9` as ERC20 is the candidate; the evm-float reconcile measures only ETH).
  **LEDGER DUPLICATION resolved:** main rows 83–94 and branch `cctp-live` rows 83–89 described
  the same events; main's set kept (finer), the two correction rows reconcile the remainder —
  `just funds reconcile` 17 pairs CLEAN @ this commit. Next: locate the pulled 0.1385 ckUSDC
  (evm-float ERC20 balance read), then the `evm-sign`/`cctp-claim` fallback lane (branch
  `cctp-live`; unproven until first live burn).
- **Prod-relay deploy incl. the partner key** — founder-run per `docs/OPS.md` §3, DO NOT NAG; the
  full unshipped list (2026-09-19 conversion-recovery wave + the 2026-09-20 CeFi live-ops wave)
  is the FOUNDER-OWNED row below. On 2026-09-20 ~22:26 the founder ran `just deploy-ic`: the
  facade canister now runs `0e75899b…` (row in `docs/UPGRADES.md`), the relay image still pins
  `e537056e…` (relay_commit `44762b3`) — `/api/v1/integrity` reads MISMATCH by design between
  the deploy's halves until the relay redeploy ships an image built from `71b3c45`+.
- **EVM gas + the CCTP burn are USER-side by design** — dpay holds no EVM key, never pays and
  never quotes gas; the burn's ETH is the user wallet's own. Since 2026-09-20 the in-intent
  gas-fund offer funds that slice from the user's OWN holdings (fund-from-wallet prepends the
  gas legs, or self-fund with recheck) — still nothing dpay pays, holds, or custodies.
- **EURC→ICP return leg (the SOL-side CeFi op's reverse leg): DONE 2026-09-22 (attempt #9) — REMOVED from the open list per the file rule; the running attempts #1–#8 narrative this entry carried is superseded by this disposition.** The FULL chain is now live-proven end to end: the venue's ICP payout layer takes the 64-hex account identifier (six consecutive first-try orders, settle = the float's identifier `9fac39d1…2279` verbatim, refund = the rail owner, every unfunded predecessor expiring with zero value at risk); the app's send surface is sound (stale-ok confirm gate + send-sheet surface ownership + the abortable seam, all live-validated in #8); the broadcast posture is `skipPreflight: true, maxRetries: 0` (817954d — the provider's broken preflight layer is bypassed, the chain is the referee; live-proven by #9's dust probe AND the funding deposit: broadcast accepted → on-chain confirmed in ~3 s); and the destination shape classifier separates `1…`/`3…`-prefixed Solana pubkeys from BTC base58 by DECODED BYTE LENGTH (32 vs 25 bytes — a pure prefix rule misread SideShift's `3ytbGFZ…GurJ` deposit address as Bitcoin mid-attempt-#9 and gated the send; fixed + vector-pinned jest, the #8-era deposit addresses `4kGiz…`/own ATA added as vectors). ATTEMPT #9 MEASURED (ledger rows 138–144): dust probe 0.01 EURC (seam proof; probe-spec error stranded 0.01 EURC + 0.00148844 SOL rent at an off-curve ATA — diagnostics self-sends must name the OWNER, the #6 precedent); the real leg: shift `d61b2eec59d5e5d45d6b`, deposit 8.8 EURC broadcast 22:14:39Z sig `5aU5jrY…kt1` (+0.000005 SOL fee, +0.00148844 SOL one-time venue-ATA rent), venue swept, **SETTLED 22:17:26Z**, and the independent ICRC-1 read shows ICP 0.05235395 → **3.39528652** — EXACTLY the quoted settleAmount 3.34293257 to the last decimal (the venue paid the ledger transfer fee). `just funds reconcile` 18 pairs CLEAN. The EURC rail now has a proven two-way bridge: EURC→ICP settles at the float in ~3 min; the reverse ICP→EURC direction is a DIFFERENT venue pair (registered, unexercised) and carries its own risk profile — exercised and CLOSED by attempt #10 the same day (see the work-order bullet above: shift `c3644b54ba21a36dabd8`, settled ~37 s, reconcile CLEAN).
- **Trocador adapter SHIPPED 503-until-key (2026-09-20; the first AGGREGATOR CeFi venue) — key
  ACCESS ENABLED 2026-09-22 (their proxy may need up to 60 min from the email before the key
  answers).** The adapter is live-capable on key arrival: the relay routes (`/api/v1/trocador/rate`,
  `/trade` POST+GET status) are registered on every build and answer 503 naming
  `DPAY_TROCADOR_API_KEY` until the founder sets it. The founder's signed partner agreement with
  Trocador's commercial team (2026-09-22 — organic-demand origin with a promised per-transaction
  budget, webhook-first status keyed on OUR internal order id, the 12-month data-retention
  commitment, `markup=0`) is recorded in
  `docs/specs/2026-09-22-trocador-partner-agreement.md`, and its code deliverables — the proxied-
  request access log + order store (a DUAL-BACKEND append-only store since 2026-09-22: the
  founder's BACKED-UP Postgres when `DPAY_TROCADOR_PG_DSN` is set — tables
  `trocador_access_log`/`trocador_order_events`, created idempotently, code only ever INSERTs,
  fail-closed (unreachable DSN refuses startup; a refused access-log write refuses the request);
  else the JSONL files `trocador-access.jsonl`/`trocador-orders.jsonl` behind
  `DPAY_TROCADOR_LOG_DIR` for the offline dev loop. OPS MUST wire the DSN in the deploy env (its
  tracked credential lives in `secrets/trocador-pg.sops.json` — now emitted into the generated
  `deploy/.env` by `scripts/gen-deploy-env.sh`; NOTE: emitting it ACTIVATES the PG-backed store,
  so the backed-up Postgres must be reachable at the next `just up` — the relay refuses to start
  otherwise, by design): the
  prod compose stack mounts NO volume, so flat files die on every redeploy — `DPAY_TROCADOR_PG_DSN`
  is already a passthrough line in `deploy/docker-compose.yml`), the
  webhook route (`/api/v1/trocador/webhook`, ≤1/min fallback polling
  stopping at the first terminal state), the upstream limiters, the privacy-policy section
  (`/privacy` §7), and the live probe — are landing in this branch. FIRST PROBE RUN 2026-09-22
  (the key now lives in `secrets/trocador.sops.json`; the probe still refuses outside a manual
  run — LIVE key-gated calls, never in verify/check): (1) the pinned coin/network codes are
  VERIFIED against the venue's key-gated `GET /coins` (2305 rows; `icp`/`sol` on `Mainnet` are
  exact pair matches — NO re-pin needed; the same-ticker wrapped "Solana (BEP20)" row is a
  different market, not our pin); (2) the trade-status vocabulary remains a /trade fact (the
  quote body previews only `status:"new"`; the resume engine keeps unknown words honest-
  `unknown` and never guesses). COVERAGE MEASURED 2026-09-22: ICP markets are LISTED but
  UNQUOTED — `icp→sol`, `icp→btc` (control) and `sol→icp` all answer `"no resulting quote"`
  while the `btc→xmr` rig-control QUOTES, so the key, params and pins are proven and the venue's
  provider pool simply had no live ICP markets that day. Consequence: SideShift remains the only
  live-settling ICP↔SOL venue; ChangeNOW stays the documented fallback #2 (same relay-held-key
  pattern); the go-live gate STANDS — re-run `just trocador-probe` immediately BEFORE the venue
  serves its first real trade. RE-RUN 2026-09-24 (same result, honestly recorded in the agreement
  spec §3): ICP markets still LISTED-but-UNQUOTED (btc→xmr control still QUOTED), so the
  trocador-usdc/trocador-eurc venue rows stay UNREGISTERED — registering them is blocked on the
  venue, not on code. What shipped 2026-09-24 so the unquoted state is a HANDLED state, not an
  error: the app detects the venue's no-quote body in `fetchCefiQuote` and says so — attributed,
  honest ("lists this pair but has no live market right now. Nothing was sent."), four locales,
  e2e flow 207; and `docs/CONVERT_MATRIX.md` is now GENERATED from the venue registry + health
  (scripts/gen_convert_matrix.mjs, staleness-gated inside `just check`), so venue coverage is a
  build-checked fact instead of prose. Founder note (no API flag refuses it): Trocador's
  `markup=0` pin keeps the USER's price at the venue's own baseline, but Trocador still accrues
  half of ITS own commission to the partner account — what happens to that accrual is a founder
  decision, outside code.

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
device-to-provider shape to copy. *(Superseded 2026-09-15: Jupiter IS registered, V11 is
RESOLVED — see item 3b.)*

**3b. Swap-venue expansion — DONE (2026-09-15): feasibility → four venue/route waves, all
offline-gated green.** Authority: [`docs/specs/2026-09-14-swap-venue-feasibility.md`] (deep
pass + founder decisions 2026-09-14: DFX register-only-after-DEX-PoC; SINGLE multi-hop intent
— supersedes the 2026-09-07 spec's multi-hop non-goal, see
[`docs/specs/2026-09-14-multihop-conversion-spec.md`]; relay-held provably-non-withdrawal
partner keys allowed, switch to pure read-only the day a venue offers one). Shipped:

- **ICPSwap ICP↔ckUSDC + ICP↔ckETH registered** (`9ceee43`; live-probed both pools,
  per-venue decimal scaling in the probe).
- **Route A multi-hop: ICP→ckUSDC→USDC(Ethereum)** as ONE intent — 5 device-signed IC legs
  (swap + dual-approve + `withdraw_erc20`), per-leg recovery, ckETH-gas preflight
  (`01ac9ba`,`925c5ec`; flow 184).
- **Jupiter = first `solana_amm` venue** (SOL↔USDC(SOL), rail-local): V11 RESOLVED — Convert
  reaches Solana wallets; pre-sign beneficiary check on the venue's own tx bytes
  (`56acda4`,`75da767`; flow 185).
- **Cross-rail Route B/C: ICP→USDC(Solana)→SOL** as ONE intent — adds the CCTP V2
  `depositForBurnWithHook` calldata leg (EVM handoff: user's own wallet signs, dpay holds no
  EVM keys; Circle-attestation watch; SOL leg device-signed) (`9a756ed`..`308c2fa`; flow 186,
  incl. reload-mid-crossing recovery). Offline-proven end-to-end; real-value run is
  founder-outer-loop.
- **SideShift CeFi adapter + relay-held partner-key infrastructure** (the SOL-RPC env
  pattern; quotes+orders proxied because SideShift's account IS the integration;
  keyless status device-direct; `commissionRate` pinned `0`; routes answer 503 naming the
  env vars until the founder's key exists) (`80c4279`..`9466777`; flow 187; keyless mainnet
  tripwire live: pair icp/sol).
- Two UX-expert passes over the new surfaces (`407cb63`..`d12d545`, `7b3f240`..`4873586`);
  flow 140's shared-pool sibling-swap race fixed (private relay).

Gates at close: full `just verify` GREEN (**177/177** e2e incl. visual flows), `just app`
self-check PASS on real hardware, `just swap-venue-probe` walks 3 IC venues + the SideShift
tripwire. Founder-owned from here (DO NOT NAG): ~~relay deploy of the wave~~ DONE 2026-09-27
(prod relay at `ef37c12` then `3bc53ff`, `verify-relay` MATCH, facade integrity MATCH),
~~SideShift signup → `DPAY_SIDESHIFT_SECRET`/`DPAY_SIDESHIFT_AFFILIATE_ID`~~ DONE 2026-09-27
(live in prod, quote-verified — see §4 below), live Route-C value run, DFX B2B revisit (its own
precondition — offline
DEX-route PoC — is now met), WC in-session signing + EVM deep-link design (spec §10 notes).

**3c. Conversion-coverage expansion — DONE (2026-09-16): six more venues registered, all four
waves of the spec shipped.** Authority:
[`docs/specs/2026-09-16-convert-coverage-expansion.md`](docs/specs/2026-09-16-convert-coverage-expansion.md)
(§1 census: 875 ICPSwap pools measured live; VEUR has zero pools on any rail — honestly
convert-less). Shipped: **four more ICPSwap pools** — ICP↔ckBTC, ckBTC↔ckETH, VCHF↔ckUSDC,
ckUSDC↔ckETH (`88dada5`; the 2026-09-14 "register ckBTC on depth improvement" condition FIRED:
re-measured 1.11 ckBTC / 50,980 ICP on the deepest ckBTC pool, ~2× the 2026-09-14 side) — plus
**jupiter-eurc** (SOL↔EURC) and **jupiter-usdc-eurc** (USDC↔EURC; the 2026-09-16 "~13% spread"
skip was a 1:1-parity artifact — re-measured 2026-09-19 against the real EUR/USD rate ~1.17:
10 USDC → 8.698735 EURC on a direct DefiTuna pool (priceImpactPct 0.000002) and 8.6 EURC →
9.885319 USDC on Whirlpool, both within ~2-3% of fair; flow 193)
and **sideshift-usdc**, completing the SOL destination set; and **sideshift-eurc**
(2026-09-19, the EUR→IC bridge — ICP ↔ EURC(Solana), the only registered route between the
two; pair verified keyless both directions live: `/pair/eurc-solana/icp` min 8.695552 /
rate 0.394900665262, reverse min 3.50126051 / rate 2.437182922012) completes the EUR rail's
IC direction; the **SOL out-destination picker**
(two venues on one mint made the second silently unreachable; registry-order rows, the first
preselected so one-venue behavior is unchanged, a pick re-targets the pair — flow 189); the
**10× verbosity cut** on every convert surface (spec §3: deleted tails, details folded behind
one disclosure, error bodies untouched); **Jupiter behind the relay** (proxy + client dials the
relay, registry endpoint stays identity-only). The standing mainnet probe EARNED its keep this
wave: its first pass exposed the probe's own 1-whole-ckBTC sizing as an economic assumption
(per-ledger sizing, `42996bc`), and the corrected walk measured `icpswap-ckusdc-cketh` —
registered on reserves, which are not spot-indicative — quoting ~77× above its own published
price; **UNREGISTERED with evidence** (`8ade315`). Twelve venues ship (six IC pools + three
Jupiter + three SideShift); FLOWS.md regenerated by `just check`. SideShift partner-key state
(2026-09-27, SUPERSEDES the 2026-09-19 note): the credential is sops-encrypted at
`secrets/sideshift.sops.json` and now LIVE IN THE PROD RELAY (`DPAY_SIDESHIFT_SECRET`/`DPAY_SIDESHIFT_AFFILIATE_ID`
reach the container via generated `deploy/.env` + compose; relay commit `3bc53ff`). Live-verified
by an end-to-end quote through `POST /api/v1/sideshift/quotes`: 4 ICP → 11.128054 EURC,
rate 2.7820135, venue min 3.11458262 — attributed + timestamped, the 503 "not set up on this
relay" era is over. Trocador proxy likewise live (credential path proven). The flagship
composed VCHF→EURC trip now waits only on the VCHF float top-up (SideShift CeFi minimum ~3.11
ICP deposit ≈ CHF 14 at the 2026-09-27 rate). Remaining externals (DO NOT NAG): the VCHF
top-up go, a live Route-C value run, the DFX B2B revisit (precondition met). ckSOL watch
continues (the mainnet ckSOL canisters are still the devnet variant).

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

**6. HIGH — drop the word "till" (→ "checkout") and "ring up" from the whole tree — DONE
(2026-09-24, this rename wave; founder decision 2026-09-16, breaking rename approved — no external
users).** "Till" was British-retail English the sector does not use (the OpenCryptoPay standard
itself says "cash register"); "ring up" went too, for plain "create/open a charge". The replacement
noun is **checkout** (Stripe/Shopify precedent; "terminal"/"POS" were rejected — hardware
connotation collides with the "no POS hardware" pitch line). What shipped, layer by layer:
`dpay_core::CheckoutOpen`/`validate_checkout_open` with the SIGNED domains `dpay-checkout-open-v1/v2`
(signing buffer fixed prefix 81 → 85 bytes — the domain is longer; the payment wire is untouched);
wasm exports `w_checkout_open_sig`(+`_note`); FFI `checkout_open_signature` with regenerated
Kotlin/Python bindings; pins regenerated via `just wire-layout` (`dfx/checkout_open_signing.json`)
and re-signed (`dfx/checkout_wire.json` — the golden input's signature was recomputed under the new
domain, example host `checkout.example`); relay `src/checkout.rs`/`CheckoutStore`, routes
`/api/v1/checkout*`, `DPAY_ENABLE_CHECKOUT`, capabilities `{"checkout":true}`, cashier pages
`checkout.html`/`checkout-code.html`; app `services/checkout.ts`, `components/CheckoutCharge.tsx`,
`CHECKOUT_OFFER`, `checkoutSettlement*`/`checkoutFeeRaw`, testIDs `checkout-*`/`btn-checkout-open`;
i18n subtree `pay.checkout.*`/`receive.checkout.*` in all four locales with COPY reworded (en "open
a fresh charge"; de keeps natural Kasse wording; es caja; fr caisse — no locale says till or ring
up); e2e flows renamed keeping ids (114-checkout-open, 205-checkout-settlement-predicate, …) +
FLOWS.md regenerated; android bridge + manifest; all living docs. History: the scan-audience label
`M.receive.checkout.checkoutCode` had already been reworded earlier in the wave. Old AsyncStorage
keys: none existed under `dpay.till*`, so nothing needed to die. Validation round (2026-09-24): the
zero-match criterion's `ring[- ]?up` missed the INFLECTED "rings up"/"ringing up" — ~30 sites swept
(incl. the SERVED cashier page's "never rings up" and the regenerated FFI bindings' doc), gates re-run green.
Re-validation round (2026-09-24): the criterion's word list missed more INFLECTED and participle
forms — ~25 sites swept ("rings one up", "rings the charge up", "ring a sale/charge up", "rung
anything up", "re-ring(s)"/"re-ringing", "rings it/that away", plus the underscore-fused
identifiers a test-local `ring_up` helper and five ring-up test/variable names carried) and one
doubled-word artifact the sweep's own edit left in `app/lib/deepLink.ts`; all reworded to plain
open/void charge language, FLOWS.md regenerated, gates re-run green. Sanctioned remaining
records: the item narrative above, the verbatim prod curl at line 486 (marked "named 'till' at
the time"), and the glossary row.

**7. IC hub 2-hop generalization — DONE (2026-09-18, closed by the convert-hub slice).** What
shipped: `hubRoutes(catalog, fromLedger)` in `app/routes.ts` walks the REGISTRY (no hardcoded
hub) for every 2-leg IC path and is exposed through `resolveConvertDestinations` (direct first,
hubs after, registry order, never ranked); `prepareHubConvertRecord` signs all four legs in ONE
pass (approve→swap→approve→swap, shared expiries, every quote verbatim attributed+timestamped,
no dpay cut); execution follows the multihop recovery story exactly — a failed second leg leaves
the first leg's output in the user's own wallet (`failed_leg`/`swap_refused`), the hop watcher
settles on a ledger row, and the ckETH-gas preflight stays fail-closed. The D1–D6 destination
UX (one row per ASSET, mechanism sub-picker on selection, nothing preselected but registry
order) landed with it; the ckBTC fee was measured live (icrc1_fee → 10 sats, 2026-09-18) and
pinned end-to-end so its hub pairs stop fail-closing. Covered by jest `convertHub.test.ts`
(33 tests) and e2e flow 190 (happy 4-leg run + deterministic swap2-refusal choreography).
Residual (not a blocker): the fee pin is AHEAD of the prod relay's `/api/v1/currencies` row
until the founder-run redeploy; prod display unaffected (relay sole catalog authority).

**8. Multi-currency build-out wave — DONE (2026-09-24; nine flows 201–209, 199/199 e2e green on
the merged tree, `just app` device self-checks green).** What shipped, one line each: **send
terminal** — ONE shared `SendTerminal` surface for the IC send sheet AND the SOL withdraw sheet's
settled/unknown phases (status glyph, amount+unit, destination, tx reference — IC blockIndex /
SOL signature — with copy, View receipt through the existing `TxnReceipt` at Wallet root, SOL-only
Check-status via read-only `getSolSignatureStatus`, honest pending, refund-safe failure lines);
pinned invariants: retry is offered ONLY before broadcast (`broadcast.sig === null` on SOL; the IC
sheet's catch no longer maps post-submission throws to the retryable form), post-acceptance
failures land in `unknown` never `error`, the same signed bytes are never re-signed, and the sheet
never re-arms a second `withTimeout` on retry; the SOL hang audit (every await → bound → owner)
lives as the `app/solana.ts` header comment; test seams: `__DPAY_TEST_SOL_SEND_TIMEOUT_MS` +
the test-helpers-gated `POST /api/v1/test/solana-upstream/mode {confirmAfterHits|failAfterHits}`;
flows 201/202. **CeFi lifecycle honesty + the abort window** (extends the 2026-09-19 Stop): a
record expired from `awaiting_deposit` keeps a SLOW watch and honors the venue's later words from
`quote_expired` (refunded→provider_refunded, processing→provider_processing, completed→done,
never backwards); `cefi.noExpiryLine` when the venue publishes no expiry (Trocador);
`cefi.lastCheckedLine` on provider_processing (a timestamp, never an SLA); Stop now covers
`awaiting_deposit`/`provider_processing` (flavor `provider`: no deposit → order dies; deposit
sent → may still settle), `crossing` (watching; funds at the user's own ATA) and `sol_ready`
(clean; final Jupiter leg unsigned); no convert record is written before the confirm tap
(pinned; the ONE pre-broadcast side effect — a CeFi confirm CREATES the venue order — is named on
the surface); flows 208/209, spec `docs/specs/2026-09-24-cefi-lifecycle-abort.md`. **Accounts
grouped by currency** — `groupAccountsByCurrency` in `app/config/currency.ts`: home-currency rails
first, then other offered currencies, then the non-currency tail; headers NAME the currency; rows
keep their own units; NO sums, NO magnitude ordering (the honesty rules `orderAccounts` already
encodes, now presentation-wide); one lock-gated rail-switch affordance per multi-rail currency
section (selects an asset row, never the home currency); flows 203/204. **The cashier picks the
settlement asset at open** — `checkoutSettlementAssets` generalizes the VCHF-only offer to every IC
row whose catalog fee is stated (the `checkoutFeeRaw != null` honesty gate); the price unit follows
the pick and the wallet asset follows with it; the relay's answer `asset` is verified and a
wrong-asset answer refuses with a one-tap fix (`served-other`); flow 205 + flows 114/115 extended.
**Convert destinations grouped by currency** in the picker (presentation only, registry order
preserved within groups, nothing preselected); flow 206. **Trocador no-quote honesty + the
generated convert matrix** — see the Trocador state bullet above; flow 207. FOLLOW-UP (the wave's
one open item): the picked settlement asset is verified via the ANSWER's `asset` field because the
checkout-open body's signed bytes are pinned (`dfx/checkout_open_signing.json`) and an unsigned field in a
signed request is unattributable — a relay that only serves VCHF fails the app closed with a named
fix, which is correct today but means multi-asset checkout needs the asset INSIDE the signature:
new signing domain version, regenerate the pin via `just wire-layout`, relay echoes it. Value 7,
effort M (wire+relay+app).

Beyond item 6 (both now DONE, above) the remaining list is the physical/outer-loop gates (below, founder-run) and the
DO-NOT-NAG set.

**Objective state (compressed history — the currency-first frame, founder 2026-09-04):**
- **O1 home currency** — BUILT, gated green, shipped; spec
  [`docs/specs/2026-09-04-currency-first-wallet-plan.md`](docs/specs/2026-09-04-currency-first-wallet-plan.md).
- **O2 rail choice** — `3d44de1`→`470b0b6`; EUR dual-rail (VEUR@IC thin + EURC@Solana deep)
  `0ab1881`→`351952b`; same spec + its findings addenda.
- **O4 Revolut-IA home tab** — `b5912b6` + `711b0ef` + `798edc2` (Balances modal retired, flows
  133–136).
- **OpenCryptoPay is one interop rail among several, not the strategy** (founder, 2026-09-04). The
  checkout v1 build is complete (`702c359`; plan
  [`docs/specs/2026-09-02-merchant-side-plan.md`](docs/specs/2026-09-02-merchant-side-plan.md))
  and **served by default at every layer since 2026-09-10** (`d15b596`; `DPAY_ENABLE_CHECKOUT=false`
  is the operator opt-out). What remains of it is the two-handset tap (below). The cashier page
  (`8805027`), the OCP tx-id fix and the bearer-token revisit are done and recorded below/inline.

## PROD STATE (checked, never asserted — the floor is now DERIVED, not hand-recorded)

As of 2026-09-16 the floor mechanism is automatic: every `just` test recipe annotates
`scripts/testruns.py` → `.dev/testruns.db` (commit + worktree tree hash + result), and
`just floor` = live relay commit → recorded evidence at that exact tree. The hand-written
floor notes below are HISTORICAL (last hand-bumped floor: `d2f3bde`, 2026-09-15).

Re-measured 2026-09-14, HEAD `e2b3002`:

- Live version → **`e2b3002…` = HEAD, clean** (no `-dirty`; commit_date 2026-09-14T02:06:54+02:00;
  measured via `curl /api/v1/version`). Everything is shipped through the fee-netted
  request-payment cell pin.
- `GET /api/v1/integrity` → **MATCH** on `e537056e…` (facade unchanged since the 2026-09-08 row;
  pin recorded in `docs/UPGRADES.md`). (Previous match at this hash: 2026-09-10.)
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
- **The checkout IS served in production** — `curl -s https://dpay.kalaj.org/api/v1/capabilities` →
  `{"till":true,"demo_faucet":true}` (re-measured 2026-09-14 at `e2b3002`; the capabilities key was named 'till' at the time): the checkout + demo faucet
  flags are live. (The pre-deploy "checkout NOT yet served" note is retired.)

**Verified-clean floor for the next session's review: `e2b3002`** — founder-run `just verify`
2026-09-14 with ONE RED: `test-canister`'s
`reconcile_walks_backwards_pages_and_repairs_orphan_older_than_one_page` panicked inside Pocket-IC
itself (HTTP `IncompleteMessage` on the `await_ingress_message` hop — a transport failure, not an
assertion). Re-run GREEN in isolation (32 s) AND as the full suite (`cargo nextest run -p
dpay-canister-tests` → 61/61 GREEN, 117 s) — classified a one-off Pocket-IC load flake, not a code
bug. What that run did NOT re-prove (it aborted at `test-canister`): e2e (last full-green 162/162
at `157b6ea`, load ×1.20) and the device gates `just app` / `just ondevice` (last hardware
self-check GREEN at `157b6ea`; apk-proven floor remains `eaaa60e`). Start the next sweep from
`e2b3002`.

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
- **Checkout tap on two physical handsets** — the merchant counter arming the reader from a live
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
- ~~**Relay deploy of the 2026-09-19 conversion-recovery + 2026-09-20 CeFi live-ops waves**
  (founder-run, `docs/OPS.md` §3): HEAD carries five prod-visible fixes the 2026-09-19 live
  testing proved necessary — the ICRC-2 approve
  arg/decoder fix (conversions wedged at "Approving" forever), the stale-destination-quote guard,
  the ICP-index ICRC-3 mirror (`/api/v1/transactions` 503s prod-wide), the settlement-probe
  timestamp floor, and the fake-IC approve fidelity + flow 191 — plus the 2026-09-20 CeFi
  live-ops wave: `end_user_ip` XFF honoring (the reverse-proxy deployment shape — without it
  SideShift refuses every partner request), rail-scoped refundAddress validation on
  `shifts_fixed`, and the fee-pin/catalog rows ahead of prod. Until deploy, prod `/wallet`
  still wedges conversions at "Approving" and the stuck watch cannot self-flip.~~
  **DONE 2026-09-27:** prod relay deployed at `ef37c12` (the whole Ballast + two-tap convert
  wave) and `3bc53ff` (sops-generated env + CeFi proxy credentials in compose); `verify-relay`
  MATCH, facade integrity MATCH, and every listed fix has shipped (conversions no longer wedge;
  the hub's self-flip is in). The SideShift credential is live (quote-verified; see the
  conversion-coverage entry).
- **Confirm-or-correct the reconstructed first-run UX decisions** —
  `docs/specs/2026-09-07-ux-decisions.md` records four decisions that are already SHIPPED IN CODE
  (preference-reason suppression, chooser preselect removal, first-run landing, rehearsal reframe)
  but that no founder statement in the repo supports. The doc says so itself and asks for
  confirmation; it is the only record, so leaving it unconfirmed means the code embodies decisions
  nobody can check. The first-run landing one is the sharp edge: it narrows a standing `CLAUDE.md`
  decision. Also open: the two forks in
  [`docs/specs/2026-09-08-first-run-redesign.md`](docs/specs/2026-09-08-first-run-redesign.md) §1.
- ~~**Whether a person-to-person request is a *price* at all** — asking a friend for CHF 10 and
  receiving CHF 9.9999 may be the wrong default even though asking a customer for CHF 10 is not
  (since 2026-09-14 every payee-quoted wire nets the fee; the flip seam is the
  `nettedWireRaw`/`netSolWireLamports` callers in `ReceiveMode`/`SolReceiveMode`).~~
  **RESOLVED by founder decision (2026-09-14):** a person-to-person request IS a price in display
  terms. Every user-facing amount for a netted request payment shows the GROSS (the typed price;
  payer side = wire + fee = the exact total debit) on both devices — review, paid, request-tracking,
  result, home activity, and the tx-log rows' headline. Fees appear ONLY as a per-transaction
  annotation in the log ("received 0.01 VCHF − 0.0001 VCHF fees"), hidden when the fee is 0 or
  unknown. The WIRE stays netted exactly as before (`nettedWireRaw`/`netSolWireLamports` and
  everything signed/sent is unchanged); the gross/fee ride along as device-saved note metadata
  (`services/txNotes.ts`) that the log rows render. **Offline half completed 2026-09-15
  (`9ec2a36`→`812f661`):** the payer's OFFLINE review keeps the exact requested amount too —
  live fee → persisted ledger-fee cache (`dpay.ledgerfees.v1`) → catalog row → wire-only, at
  DISPLAY seams only (signing still requires the LIVE fee; BadFee) — and the same gross drives
  the pending-outbox rows and the offline deduction (`dpay.pendingpays.v1.<publicHex>`,
  flows 179–182), so an unconfirmed offline payment renders and deducts at the gross it will
  actually move.

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
cooldown; the checkout stays session-pinned and the faucet single-address; all shared walk state
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

## EVM rail — generic ERC-20 custody (filed 2026-09-26; BUILT 2026-09-26/27 on branch `evm-rail` —
## spec `docs/specs/2026-09-26-evm-rail-spec.md` + its addenda; remaining: the live legs below)

- **Why**: founder directive 2026-09-26 — "we should add ERC-20 support anyway", driven by ZCHF /
  Frankencoin (the OISY-parity ask: OISY holds ZCHF, dpay cannot). dpay settles ck twins and
  bridges via the minters but holds NO raw ERC-20, and there is no ckZCHF twin to bridge into (the
  ckERC20 family is ckUSDC-only). ZCHF is a plain OZ ERC-20 (18 decimals, EIP-2612 permit, verified
  source); the vendored `third_party/oisy-wallet` env files pin its deployed addresses: Ethereum
  mainnet `0xB58E61C3098d85632Df34EecfB899A1Ed80921cB`, Arbitrum
  `0xD4dD9e2F021BB459D5A5f6c24C12fE09c5D45553`, plus Base and Polygon copies.
- **Shape — a SOL-rail sibling, app-only; the facade, wire, and core are untouched** (same rule as
  SOL): device-held EVM key (secp256k1, non-custodial, one address across all EVM chains);
  `catalog.rs` rows keyed per (chain_id, token) — first rows Ethereum mainnet + Arbitrum ZCHF;
  ERC-20 `transfer` signed on device; broadcast through a relay RPC proxy per chain (the R2
  `DPAY_SOLANA_RPC_URL` pattern — provider endpoint in deploy config, never the app bundle);
  balance/history indexed by `eth_getLogs` Transfer-topic polling on the relay. The standing
  invariant carries over unchanged: dpay holds no EVM key, never pays and never quotes gas.
- **"App-only" means where value custody and settlement live. It does NOT contrast with a
  facade-settled IC rail; no such rail exists at HEAD.** Per-rail truth (`docs/CANISTERS.md` is the
  authority; since the 2026-08-19/20 user-principal cutover): on EVERY rail the device holds the
  key, the app builds and signs the transaction, and the ledger of record is an external one. The
  facade canister (`ssqti`) is on no value path; its only live roles are the demo faucet `mint`,
  display reads via the relay, and the module-hash integrity pin.

  | | IC rails (ICP/VCHF, ck twins) | SOL rail | EVM rail (this) |
  |---|---|---|---|
  | Key custody | device ed25519 | device ed25519 | device secp256k1 |
  | Tx build + sign | app, direct to the ledger or minter | app, device-signed | app, device-signed |
  | Settlement | app-signed `icrc1_transfer` (native) / `icrc2_approve` + minter calls (ck) | app broadcast via relay RPC proxy | app broadcast via relay RPC proxy (planned) |
  | Ledger of record | the external ICRC ledger canisters | Solana itself | the EVM chain itself |
  | Facade involvement | none (faucet, display reads, integrity pin only) | none | none |
  | Offline pay | app-signed envelope, device-clock fallback; the MERCHANT submits (flow 19) | `solreq:v2`/`solpay:v2` recent-blockhash, merchant scans + broadcasts | not designed |

  Any rail table with rows like "app, then facade settles", "ledger of record: facade canister", or
  "offline claims: facade, settle-later" describes the pre-cutover custody model retired
  2026-08-19/20 and is wrong at HEAD.
- **Gas**: user-side. Every payer address needs dust native ETH (mainnet / Arbitrum) alongside the
  token — the in-intent gas-fund offer (CCTP wave precedent) is the onboarding pattern; ZCHF's
  permit makes any future approval signature-cheap, but plain transfers need no approval at all.
- **Custody semantics: verify from the verified source at build time, keep the receipt.** Etherscan
  surfaces a "UI multiplier" note on the ZCHF token page (displayed amounts scaled by a
  `UIMultiplierUpdated` value) while the pinned contract's ABI is vanilla ERC-20 + permit —
  reconcile that contradiction BEFORE any balance display ships; a real multiplier means the
  indexer must apply it, a stale Etherscan widget means drop it with the evidence.
- **Event capacity, measured 2026-09-26 (the triathlon question, ~5k attendees)**: Ethereum: 12s
  blocks, accept-at-1-block ~12–25s at the day's 0.09 Gwei (transfer ≈ 65k gas ≈ $0.02; absolute
  finality ~13 min, never needed for acceptance); ~65k gas per transfer ⇒ ~500 ERC-20
  transfers/block (~40 TPS chain-wide headroom). Arbitrum (the recommended event rail): 250ms
  blocks, ~1–3s soft-confirmed accept, sub-cent fees, orders of magnitude more headroom. Realistic
  load: 5,000 payments over 30 min = 2.8 TPS; a 15-min concession crush = 5.5 TPS; even an absurd
  5-min all-at-once spike = 17 TPS — all trivial for either chain and for the relay proxy (the SOL
  rail already lives at this shape; per-address nonces never contend at one-tx-per-address). The
  engineering risk is NOT throughput — it is (a) gas pre-funding UX before race day, (b) the
  confirm-UX policy (show "seen/included" at soft confirmation, never promise finality), (c)
  nonce/retry hygiene in the broadcast queue.
- **Gates**: receive address + send sheet + request auto-confirm via inclusion poll (the
  `POLL.request` precedent) as new e2e flows; `just verify` + jest + relay catalog tests with the
  `dfx/catalog_truth.json` drift alarms; mainnet + Arbitrum rows live and ONE real on-chain ZCHF
  round trip recorded before any pilot claim.
  **State 2026-09-27:** everything OFFLINE-buildable is DONE — e2e flows 218-222 drive the real
  app against a local anvil through the real relay pipe; both drift alarms + wire pins are in;
  `just verify` GREEN at `d88a69b`. The live legs are NOT done and are the reason this entry
  stays: (a) the D29 Sepolia probe IS written and green (`just evm-probe-sepolia`, chainId
  421614 verified; facts + the faucet dead-end log in `docs/live-testing/networks.md`) and
  `scripts/evm-sepolia-roundtrip.mjs` is ready but UNEXECUTED — blocked on faucet gas (every
  no-login faucet refuses a zero-mainnet-balance address; the agent EVM float is empty on-chain);
  (b) the funded mainnet round trip (D31) — the acceptance gate for any pilot claim — needs
  the agent EVM float registered in `funds/wallets.json` + a `docs/AGENT-FUNDS.md` derivation
  note, dust ETH, and ZCHF on one chain (mainnet's Uniswap V3 ZCHF/WETH 0.3% pool is the one
  liquid venue — see the networks.md EVM section). The D30 mainnet READ probe ran
  same-day (spec addendum 1: minimal permit domain, no UIMultiplier, addresses verified);
  `scripts/evm-probe-zchf-mainnet.mjs` pins it as a standing opt-in tripwire.
  **RESOLVED 2026-09-28 (same-day second trip, drip-free — the founder mandate: swap the EXISTING
  funds into a workable path):** the wall was self-funded away — 1.5 EURC→SOL via the IN-APP
  convert (a rent-free Jupiter route existed; simulated clean pre-broadcast), then EURC→ICP and
  ICP→ETH in-app shifts, and the full ZCHF round trip LANDED on Ethereum mainnet: bought 1.5 ZCHF
  (Uniswap V3 via the relay pipe), sent 0.5 in-app to the counterparty, and completed the
  offline-permit claim loop (offline sign with connectivity pinned down → B settled permit +
  transferFrom on-chain → the app's pending badge cleared itself back online). On-chain verified
  end to end, `just funds reconcile` CLEAN, per-leg table in `docs/live-testing/networks.md`.
  **"ZCHF held / sent / received offline-capable in dpay on mainnet" is now PROVEN.** The leg
  scripts carry the fixes the live runs shook out (QuoterV2 tuple, SwapRouter02 shapes, bytes[]
  encoding, wrap+approve ETH input, local nonce sequence, history-aware settle verify).
  Zero founder drip; total float cost ~CHF 2.7 against the CHF 25 ceiling.

## D31 live-trip findings (2026-09-28 — value 6/S each; both CLOSED or sharpened by the same-day trip)

- **CLOSED 2026-09-28 (second trip): the SOL send sheet's inert confirm under unaffordable ATA
  rent — never hit again.** The rent wall itself was self-funded away before any send was
  attempted (see the resolved dead end in `docs/live-testing/networks.md`); every send in this
  trip had an affordable rent and every confirm produced a terminal state. The UX gap (a confirm
  press with no terminal state when rent is unaffordable) stands as filed below for the next UI
  session — it is a real defect, this trip just stopped feeding it cases.
  - **The SOL send sheet's confirm press is INERT when the venue-deposit ATA rent is unaffordable**
    (value 6, effort S). The review shows the exact cost honestly ("Creating it costs about
    0.00204428 SOL, paid by you") but pressing Confirm produces no terminal state, no error, and no
    next action — the driver waited 120s on any of `sol-send-outcome` / `-unknown-title` /
    `-failed-title` with zero `money: sol send` tracer lines (the submit handler never ran).
    Violates the founder hard rule "useful practical instructions on every step, especially error
    path": the honest refusal exists (the send is correctly NOT broadcast) but the user is stranded
    on the form. Repro: rail SOL < ~0.00204 with any fresh venue deposit address
    (`e2e/shots/trip-sol-send-stall.png`). Fix shape: surface the affordability gate as a disabled
    confirm WITH the reason + the exact top-up address/amount, or a terminal refusal panel.
- **SHARPENED 2026-09-28 (second trip): the EVM history poll vs publicnode** (value 5, effort S).
  The upstream refuses `eth_getLogs` without an `address` outright and 403s 10k-block spans, but
  answers address+topic queries at ≤5000-block spans fine (the trip's four rail movements came
  back exactly through the relay pipe). If the ZCHF·Eth history surface still shows the honest
  refusal at HEAD, the fix is the app's own query shape (carry the token address; cap the page at
  ~5k blocks) — not a new upstream.

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

U4 — DONE, in `62c86a4` (2026-09-10): the hand-maintained ~40-flow enumeration was deleted from `CODEBASE_ANALYSIS.md` and replaced by the pointer paragraph ("Flow coverage lives in `FLOWS.md`, not here — this file points, it never restates"; `just check` regenerating + diffing `FLOWS.md` is recorded beside it), and every non-flow fact it carried was re-homed first (the testID contract, the seed/backup surface, and the restore surface as their own paragraphs in the e2e-harness section; the asset-segregation note into "Where the design earns its keep"). The row survived that commit by oversight. It remained the only entry until U5 below.

U5 — DONE (2026-09-16) and CORRECTED 2026-09-17: the original fix was dead code twice — zero callers
passed `getSession({rebuildWeb})`, and the sirv server was spawned WITHOUT `--dev`, so it snapshotted
the dist at startup and an in-place rebuild could never have been served. Both halves are wired now:
`watch.mjs` calls `getSession({rebuildWeb: true})` before a subset re-run whenever the trigger touched
`app/**` or `e2e/web/**`, and the sirv spawn carries `--dev` (reads dist from disk per request; the
`just cleanup` reap pgrep still matches). The one-shot path is unchanged. Interactive watch
verification is still pending (the loop is unwired by design and can't ride `just verify`); the
in-place-rebuild path itself is exercised by construction (buildWeb({force:true}) is the same call
the one-shot path uses).

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
  prefixed — both accepted by DFX). Tripwires: `just ocp-ledger-probe` + flow 113. Re-measured
  2026-09-07: the tx-spelling/ledger-selection rule still holds live; `just live-ocp` GREEN
  (CHF-1 checkout quote → review, nothing signed). The old "DFX still owes the CHF 1" residual was
  written off by the founder 2026-09-14 — no longer tracked.
- **No third-party wallet can settle an Internet Computer asset** (re-measured 2026-09-05): Oisy's
  IC OpenCryptoPay payer is Option-A (`icrc2_approve` + sender report; no tx id, no memo), DFX's
  wallet list names none. Source-only detail:
  [`docs/specs/2026-09-01-opencryptopay-findings.md`](docs/specs/2026-09-01-opencryptopay-findings.md).
  **2026-09-12 — both reasons it held are gone, and BOTH fixes are uncommitted working-tree changes
  at this writing.** (1) The founder scanned a live checkout code with Oisy and got `Code/URL ist nicht
  gültig`: the relay served the provider routes with no CORS headers, so no browser wallet could
  read a dpay checkout at all (provider-CORS sub-router + tests). (2) Even read, it could not pay,
  because Oisy approves an allowance and dpay refused to collect one — so, founder-directed, the
  merchant's own phone now signs the `icrc2_transfer_from` while the relay still holds no key
  (`PullClaim` → `preparePull` → `collect`; e2e flow 177 drives the whole path offline).
  **Oisy ITSELF is still undriven** — its scanner sits behind Internet Identity, so a real payment
  needs a founder account and a franc or two. Until that run happens "a third-party wallet can pay a
  dpay checkout" is a CAPABILITY, not a claim, and must not appear in a deck, a demo or an investor
  mail. Same spec.
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
  seams: PayMode wire/link + OCP checkout, NfcTap payer, ReceiveMode payee request, SolPayMode spay
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
- ~~**SOL glyph `◎` relies on system font fallback** (U+25CE absent from every bundled font —
  fontTools cmap-verified; renders acceptably on MIUI/Android today). If a device ever shows a
  fallback artifact, swap to an in-font covered glyph (`○`/`●`). Low, visual-only.~~
  **RESOLVED (2026-09-14):** swapped to an in-font glyph — but NOT the recorded remedy, which was
  impossible: `○` U+25CB and `●` U+25CF are absent from every bundled face too (same fonttools
  audit). The SOL mark is now `•` U+2022, covered by ALL four faces (the 2026-08-23 Ξ→◊
  in-font-glyph precedent), in `AssetGlyph.tsx` (chips) and `SolReceiveMode.tsx` (amount prefix);
  tests and prose updated, and the web woff2 set needed no change (`•` was already kept, `◎` was
  never in a cmap).
- ~~**Deploy-script candid-literal drift (ops-only)** — `dfx-deploy.sh`'s ICRC init args literal is
  not factored the way staging's is (3 genuinely incompatible per-script strategies). Both scripts
  byte-faithful today; low priority, no runtime impact.~~ **RESOLVED (2026-09-14):** the ICRC-ledger
  + facade init literals now live ONCE as parameterized builders in `deploy/dfx-lib.sh`
  (`icrc_ledger_init_arg`, `facade_init_arg`), called by `scripts/dfx-deploy.sh` (local) and
  `scripts/dfx-deploy-ic-staging.sh` (staging; its differing whitespace is an explicit indent
  param); mainnet (`scripts/dfx-deploy-ic.sh`) deliberately keeps its distinct strategy — the
  tracked `dfx/args/init.arg` via dpay-fixture + the demo_ledger-vs-canister_ids.json sanity gate —
  with a cross-reference comment at its deploy call. Byte-identity of the refactor is proven and
  re-checkable offline: `just dfx-arg-parity` (`deploy/tests/literal-parity.sh`) replays both
  scripts against a mock dfx and diffs the emitted install arguments against the committed
  pre-refactor captures in `deploy/tests/fixtures/` — zero delta.
- **Doc-rot**: living docs verified clean 2026-09-15 (the 2026-09-06 pass + the
  offline-payments/outbox session landing, docs updated in the same change);
  `docs/specs/` session reports remain historical records, not re-audited.

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
