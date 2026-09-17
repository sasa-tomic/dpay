# Swap venue feasibility — ICP ↔ SOL / ETH / USDC / BTC (research, 2026-09-14)

Question (founder, 2026-09-14): "Explore the feasibility of swapping currencies (non-custodial
of course) leveraging one of the existing DEX or CEX platforms. It should ideally be KYC-free,
and support ICP swap with SOL, ETH, USDC, etc."

Everything below was **measured live against mainnet on 2026-09-14** (anonymous read-only
canister queries + public HTTP APIs), not read from marketing copy. It slots into the existing
delegated-conversion frame (`2026-09-07-delegated-conversion-spec.md`) and the multi-venue
registry (`2026-09-08-multi-venue-readiness.md`, V1–V10 landed; V11 = Solana venue boundary).

Amended later the same day after a founder-directed deep pass (less-known venues + multi-step
routes) — see the sections marked **deep pass** and **Founder decisions (2026-09-14)**.
Implementation status notes inline: the first recommended step is already shipped.

## Hard constraints recap (why a venue passes or fails)

From CLAUDE.md + the conversion spec — non-negotiable for any *registered* dpay venue:

1. dpay never a party to the trade; no dpay key/address/canister in the funds path.
2. User's device signs every funds-moving call (ICRC-2 approve + venue call, or Solana tx).
3. **No withdrawal-capable exchange credentials ever** — holding them IS custody. This
   eliminates every CEX account-based integration (Binance, Kraken, etc.) outright.
   (Boundary refined by founder decision 3 below: relay-held, provably non-withdrawal-capable
   partner keys are allowed.)
4. Venue's own quote rendered verbatim, attributed, timestamped; no ranking/blending.
5. No dpay cut.
6. KYC-free *preferred*: pure on-chain AMMs/aggregators are KYC-free by construction; any
   venue that can trigger identity checks mid-flow fails the tourist story.

## Findings per venue

### ICPSwap (IC AMM, `kind: ic_amm`) — the only registrable IC venue

Factory `4mmnk-kiaaa-aaaag-qbllq-cai`, `getPools()` queried live. Relevant mainnet pools:

| pair | pool canister | raw side readings (CLMM reserves, NOT spot) |
|---|---|---|
| ICP↔VCHF | `65mrh-fqaaa-aaaar-qapoa-cai` (shipped PoC pool) | 229,277 VCHF / 83,978 ICP |
| ICP↔ckUSDC | `mohjv-bqaaa-aaaag-qjyia-cai` | 9,236 ICP / 392,105 ckUSDC (6 dec) |
| ICP↔ckETH | `angxa-baaaa-aaaag-qcvnq-cai` | 11,312 ICP / 51.63 ckETH |
| ICP↔ckBTC | `xmiu5-jqaaa-aaaag-qbz7q-cai` | 34,642 ICP / 0.562 ckBTC |

- **Depth caveat (deep pass correction):** CLMM `getTokenAmountState` reserves are not
  spot-indicative across fee tiers — treat them as pool-size hints only. The tradeable truth
  is a live quote: the ckUSDC pool quoted **44 ICP → 122.0557 ckUSDC (0.30% all-in,
  market-aligned spot 2.783)** at CHF-scale size; 220 ICP → 610.09 ckUSDC (0.33%).
  Pool healthy.
- Same factory, same `depositFromAndSwap` shape, same ICRC-2 approve flow the PoC exercises.
  **Status: ICP↔ckUSDC and ICP↔ckETH are REGISTERED (commit `9ceee43`, 2026-09-14)** —
  truth-file rows + relay catalog + bundled app copy + fake-IC fixtures + mainnet probe pins
  (per-venue decimal scaling 8/6 and 8/18) + e2e flow 183.
  **Update 2026-09-16 (coverage-expansion wave):** the ckBTC condition FIRED — the pool
  re-measured at 1.11 ckBTC / 50,980 ICP (deepest ckBTC pool on the factory; ~2× the 2026-09-14
  side) — and ICP↔ckBTC, ckBTC↔ckETH and VCHF↔ckUSDC were REGISTERED (`88dada5`) alongside
  jupiter-eurc and sideshift-usdc. Depth honesty here is the standing mainnet probe
  (`just swap-venue-probe`), which drives the venue's real quote both ways against the pool's
  own published price. The same probe caught the wave's one mistake: ckUSDC↔ckETH (`mvcvq`)
  was registered on RESERVES — exactly what the caveat above warns are not spot-indicative —
  and quoted ~77× above its own sqrtPrice; UNREGISTERED (`8ade315`). Ten real venues ship.

### dpay's already-shipped burn-withdraw turns IC-side assets into native ETH/USDC

`cketh.ts` burn/withdraw ckETH→native ETH and ckUSDC(ckERC20)→ERC20 is BUILT and
live-proven. The deep pass verified the mainnet machinery end-to-end (read-only):

- The **ckETH minter `sv3dd-oaaaa-aaaar-qacoa-cai` governs all 12 ckERC20 tokens** incl.
  ckUSDC → ERC20 USDC (`0xA0b8…eB48`, the native Ethereum mainnet USDC contract); it holds
  ~1.85M USDC, is scraping mainnet (Finalized blocks), and `withdraw_erc20` is live.
- Flow: icrc2_approve on the ckERC20 ledger + ckETH ledger (gas), then `withdraw_erc20`;
  user signs only IC-side; one chain-key EVM tx. **Fees ≈ $0.32 all-in** (65k gas @ ~1.76
  gwei = $0.29 + ledger fees). Constraint: user must hold ckETH for gas.
- Reverse (USDC→ckUSDC mint): deposit helper live, min 10 USDC, ≈$0.63 gas; dpay already
  ships the calldata builder (`app/cketh.ts`).

### Multi-step routes (deep pass — all legs verified live 2026-09-14)

Founder direction: chained legs are acceptable ("multiple steps and hence higher fees, but it
would work"). Measured all-in costs at CHF 100 / CHF 500 sizes (ICP $2.78, ETH $2,558,
SOL $103.78, 1 CHF = $1.2238):

| route | legs | all-in cost | time |
|---|---|---|---|
| **A. ICP → USDC(Ethereum)** | ICPSwap ICP→ckUSDC + `withdraw_erc20` | **0.6% / 0.4%** | ~15 min (EVM finality) |
| **B. ICP → USDC(Solana)** | A + CCTP V2 ETH→SOL | **0.9% / 0.5%** | +~20 s fast transfer |
| **C. ICP → SOL** | B + Jupiter USDC(SOL)→SOL | **1.1% / 0.75%** | minutes |
| C′ fallback | USDC(ETH)→SOL via THORChain single hop | ~0.7–1.5%, slower | minutes |
| **D. USDC(ETH) → ckUSDC (reverse)** | CCTP/mint deposit | ≈$0.63 fixed | ~20 min |

Notes:
- **CCTP V2 is live on Solana** (source+destination): canonical native USDC, no Circle fee,
  gas only (ETH burn ≈$0.41, SOL claim <$0.05). Wormhole/Portal gives wrapped USDCet —
  rejected as primary, fallback only.
- **Quote rails on Ethereum**: ParaSwap v5 (`apiv5.paraswap.io`) is keyless and live;
  1inch is now key-gated (401); ODOS unreachable from this box.
- **THORChain** (via Liquify gateway API): `SOL.SOL` + `ETH.USDC` pools Available, outbound
  fees live (ETH ≈$0.25, SOL ≈$0.025) — usable but memo-heavy integration; fallback.
- **EVM signing boundary**: dpay has no EVM key surface by design. EVM legs follow the
  shipped ckETH onramp pattern — dpay BUILDS the calldata, the user's own wallet signs /
  deep-links. No dpay-held EVM keys ever.
- ckETH-gas dependency is the main UX cost of Route A/B (user needs a little ckETH).

### Solana — no single-venue non-custodial ICP↔SOL path exists today

- **ckSOL**: the official `dfinity/cksol` repo's mainnet canisters
  (`ljyxk-riaaa-aaaar-qb5mq-cai` minter, `la34w-haaaa-aaaar-qb5na-cai` ledger) exist and
  respond, but the ledger's own `icrc1_metadata` reports name/symbol **"ckDevnetSOL"** —
  this is the devnet variant; repo README says "under active development". No production
  mainnet ckSOL. When it lands: ICP↔ckSOL pool on an IC AMM + a SOL burn-withdraw leg
  exactly parallels the ckETH pattern — the architecture is already ready for it.
- **Jupiter (Solana aggregator)**: live keyless check `GET lite-api.jup.ag/swap/v1/quote`:
  1 SOL→10.36 USDC, price impact 0.003%, `platformFee: null` (fits the no-dpay-cut rule).
  KYC-free, non-custodial, user device signs. This is the venue V11 named for the Solana
  rail — registering it (new `kind` value) is what un-gates Convert for
  `protocol === 'solana'`. It does **not** give ICP↔SOL by itself; in Route C it is the
  final leg.
  **Update 2026-09-16 (founder ask: "get live quotes from them … possibly through our
  relay (for caching etc)")**: the V11 call path was device-direct with the relay registry-
  only; it is now RELAY-PROXIED — `crates/dpay-relay/src/jupiter.rs` pipes
  `GET /api/v1/jupiter/quote` (short-TTL cache keyed on canonical sorted query params,
  byte-faithful body) and `POST /api/v1/jupiter/swap` (never cached — the device posts
  Jupiter's own quoteResponse back and must receive the swapTransaction unmodified) to
  `lite-api.jup.ag`. Same R2 marker contract as the Solana RPC proxy: upstream statuses
  verbatim, transport death → 504 `jupiter-upstream-unreachable`; keyless, so no 503
  state and the registry row's `endpoint` (`https://lite-api.jup.ag`) stays as the venue's
  identity/attribution, no longer a dial target. Operator override semantics follow R2.
  The signing boundary is unchanged: the venue returns an UNSIGNED transaction, verified
  (fee payer = the user) and signed on-device.
- **Chainflip**: BTC/ETH/SOL/POL — **no ICP**.

### KongSwap — discontinued (founder-confirmed), reject

The venue Oisy integrated (backend `2ipq2-uqaaa-aaaar-qailq-cai`, the id in Oisy's
`dfx.json` remote): `tokens()` still lists 132 IC tokens, but `pools()` returns
`(variant { Ok = vec {} })` — **zero pools, drained**. `kongswap.io` and all subdomains
return Cloudflare 530/1016 (origin gone). CoinGecko showed ~$2.44 24h volume on KONG.
Founder confirmed 2026-09-14: discontinued. Do not build against it; revisit only if it
demonstrably relaunches.

### Less-known CeFi / instant exchangers (deep pass, live-checked 2026-09-14)

- **ChangeNOW — FAIL (ICP delisted).** Live keyless API: ICP absent from
  `api.changenow.io/v2/exchange/currencies`; `min-amount?fromCurrency=icp` →
  `pair_is_inactive`. The ICP webpage is a stale SEO shell. KYC is risk-triggered (Sumsub).
  Re-check on relist.
- **SwissBorg — FAIL.** MiCA-licensed custodial app, unconditional KYC, no third-party API.
  (Lists ICP since Sep 2025 — irrelevant without API.)
- **DFX (dfx.swiss) — PASS-with-tradeoffs; the only registerable CeFi found.** Fiat broker +
  crypto swap, VQF/SRO-regulated (DFX Services AG, Zug). Live keyless catalog
  (`api.dfx.swiss/v1/asset`, 182 assets): ICP (id 420), SOL, ETH, USDC on Ethereum/Polygon/
  Solana/Base/Arbitrum/Optimism/BSC. Public quote endpoint (`PUT /v1/swap/quote`: rate,
  fees, min/max, exactPrice); swap creation is per-user session (`PUT /v1/swap/paymentInfos`
  → deposit address; `POST /swap/paymentInfos/{id}/confirm`) — dpay never holds a
  withdrawal-capable key. Threshold-KYC ladder (refund after 7 days if refused), Scorechain
  address screening, SEPA/CHF/EUR fiat side (relevant to the separate fiat-funding
  objective). Tradeoffs: DFX is principal mid-trade, KYC at size, Swiss AML gate.
- **Field sweep**: SideShift.ai — ICP live, no keyless API (account+token; old api host
  NXDOMAIN). SimpleSwap — ICP live, API key-gated; running a "ONE_TIME_KYC_EXPERIMENT"
  since 2026-03. LetsExchange — ICP↔SOL live, partner-oriented API (not keyless).
  Trocador — ICP listed (aggregator; partners may KYC). FixedFloat — bot-walled, publishes
  0.5% float / 1% fixed. Exolix, ChangeHero — no ICP.
- **IC DEX sweep (beyond ICPSwap)**: ICDex/ICLighthouse — order-book, pairs exist on paper
  (router `i5jcx-ziaaa-aaaar-qaazq-cai`) but books are empty/junk (ICP/ckUSDC: one joke
  ask, vol24h=0; no VCHF pair) and execution is deposit-account custody — not registrable.
  Oisy Trade — 3 tokens, ~23% spread, deposit-custody — no. Sonic — WICP wraps only.
  Bitfinity — EVM EOA keys required (IC identity can't sign EVM txs) — out of scope.
  InfinitySwap never launched. HoudiniSwap/SwapSpace — custodial aggregators, fail rules.
  **ICPSwap remains the only registrable IC venue.**

## Feasibility matrix (asked pairs)

| pair | verdict | path |
|---|---|---|
| ICP↔USDC | **Feasible — registered** | ICPSwap ICP↔ckUSDC pool (live, healthy; commit `9ceee43`); Route A/B extend to native USDC |
| ICP↔ETH | **Feasible — registered** | ICPSwap ICP↔ckETH + existing burn-withdraw (Route A shape) |
| ICP↔BTC | **Feasible — registered** | ICPSwap ICP↔ckBTC re-measured 1.11 ckBTC / 50,980 ICP, registered 2026-09-16 (`88dada5`); probe-verified live |
| ICP↔SOL | **Feasible as multi-hop** (Routes B/C verified leg-by-leg) | ICP→ckUSDC→USDC(ETH)→USDC(SOL)→SOL; single-venue path waits on mainnet ckSOL |
| ICP↔VCHF | Shipped | the live PoC |
| SOL↔USDC (rail-local) | **Feasible — registered** | Jupiter (`jupiter` 2026-09-15; `jupiter-eurc` 2026-09-16 adds SOL↔EURC), keyless, no platform fee, relay-proxied |

All DEX paths above are KYC-free by construction. Registered CeFi (DFX only) is
threshold-KYC by law — hence "register after DEX PoC" decision below.

## Founder decisions (2026-09-14)

1. **DFX**: register only after the DEX routes have a live PoC. DFX stays a researched
   candidate in this doc until then.
2. **Multi-step UX**: build as a **single multi-hop intent** — one "ICP→SOL" flow
   orchestrating all legs with per-leg status/recovery. (Supersedes the delegated-conversion
   spec's multi-hop non-goal; spec amendment lands with the implementation.)
3. **Relay-held partner keys**: allowed for quote surfaces, with boundary — keys are held on
   the relay (user never sees them), must be provably non-withdrawal-capable (no funds on
   those accounts ⇒ nothing to withdraw), and dpay switches to pure read-only keys when a
   venue offers them. Amends constraint 3's grey area; withdrawal-capable keys remain
   absolute no.

## Partner-key infrastructure (2026-09-15, SideShift first adapter)

Decision 3 built, as the pattern said it should be — one canonical shape, SideShift as the
first credential it carries.

**The pattern (canonical, `crates/dpay-relay/src/solana.rs` shape):**
- env `DPAY_<VENUE>_<CREDENTIAL>` via `non_empty()` → `Option` in `Config`; unset is LEGAL —
  the route registers on every build and answers **503 naming the missing variable** (`503`,
  never 404: an unconfigured surface is a fact to report, not a hole to hide). Error paths name
  the VARIABLE; the value is never logged, echoed, or committed.
- the relay attaches the credential server-side (`x-sideshift-secret`); the device never sees
  it. Upstream HTTP errors pass through verbatim; relay-originated failures carry the
  `{"dpayRelayError": …}` marker body (same contract as the Solana RPC proxy).
- partner-key routes are query/order-surface only — no value ever moves through the relay.

**SideShift specifics (verified live 2026-09-15, not from cached posts):**
- Host `https://sideshift.ai/api/v2/` (the OLD `api.sideshift.ai` is NXDOMAIN — the doc's
  original finding, confirmed). V2 strongly advised; V1 deprecated.
- Auth split, decisive for the design: **account = the integration, not the user** (their
  create-account docs say so) — there is NO per-user session to put on a device, so BOTH the
  quote (POST /quotes) and the fixed order (POST /shifts/fixed) go through the relay proxy.
  **Shift status (GET /shifts/{id}) is KEYLESS** (probed live with a real 2021 shift id) — the
  resume engine polls it device-direct, so the relay is not in the status path at all.
- `x-user-ip` must be forwarded on server-sent requests (their no-proxying rule) — the relay
  forwards the connecting client IP, omitted when not visible, never fabricated.
- Monetization: commission 0.5% default, 0–2% configurable, INSIDE the rate. The relay pins
  `commissionRate: "0"` — at 0% the user gets a *better* rate than the website's — so dpay is
  paid nothing and the no-dpay-cut red line holds by construction.
- Status vocabulary (`waiting`, `multiple`, `settled`, `refund`, `refunded`, `expired`,
  camelCase `settleAmount`/`settleHash`) mapped additively onto `PROVIDER_STATUS_MAP` in
  `app/convertResume.ts` — the declared adapter contract.

**The cefi pair schema decision:** `dfx/catalog_truth.json` cefi rows key `pair_ledgers` as
**rail-canonical identifiers** — the IC side's ledger principal and the Solana side's mint
(wrapped-SOL for native, per the Jupiter precedent), exactly the cross-rail ids the survey
treated. Unordered like every row. The relay owns the rail-id → venue coin/network code
mapping (`icp`→`ICP`/`icp`, wrapped-SOL mint →`SOL`/`solana`); the device speaks rail ids only.

**The founder boundary, restated as built:** the key on the relay is the partner account's
secret — SideShift offers NO read-only key today. It is non-withdrawal-capable by the decision's
own test: the account will hold NO funds (deposits go to per-shift addresses; settlement pays
the USER's address directly), so there is nothing the secret could withdraw. **Switching to a
pure read-only key the day SideShift offers one is mandatory, not optional.** Withdrawal-capable
credentials remain an absolute no. The founder-owned live gate: **signing up at sideshift.ai is
a founder step** (one account for the whole integration, per their docs) — until it happens the
routes answer 503 naming the variables, which is the designed honest state.

**Where it lives:** relay module `crates/dpay-relay/src/sideshift.rs` (routes
`POST /api/v1/sideshift/quotes` + `/sideshift/shifts/fixed`, always registered); device client
`app/services/sideshift.ts` (quote/order via relay, status device-direct); registry row
`kind: "cefi"`, `venue_id: "sideshift"` (bundled `app/config/venues.ts` + compiled relay catalog
+ truth file, drift-alarmed both sides); offline stand-ins: relay test stub
`/api/v1/test/sideshift-upstream` + e2e page-stub `e2e/harness/sideshift.mjs` (cefi rows are
ic-fixture-free by rule); flow 187 drives quote → deposit handoff → status lifecycle →
reload-resume → dead-ends. Opt-in keyless mainnet tripwire:
`sideshift_keyless_quote_surface_still_answers` in `crates/dpay-relay/tests/swap_venue_mainnet.rs`
(runs with `just swap-venue-probe`). Env vars documented in `docs/OPS.md` §3.

## Work order (updated after the 2026-09-14 registrations)

1. ~~Register ICPSwap ICP↔ckUSDC and ICP↔ckETH~~ — **DONE, commit `9ceee43`** (probe
   ratios 0.9969–0.9970 live; e2e flow 183 green).
2. ~~Multi-hop orchestration: single intent, per-leg status/recovery (widens
   `app/convert.ts` legs shape + Convert UX; extends the record schema)~~ — **DONE,
   2026-09-15: Route A as one intent (`01ac9ba`,`925c5ec`; flow 184).**
3. ~~CCTP v2 + Jupiter legs (Routes B/C) on the EVM-calldata-build/user-wallet-signs pattern~~ —
   **DONE, 2026-09-15: Jupiter leg (`56acda4`,`75da767`; flow 185) + Route B/C
   (`9a756ed`..`308c2fa`; flow 186).**
4. ~~Relay-held partner-key infrastructure (SOL-RPC-key pattern; SideShift first candidate)~~ —
   **DONE, 2026-09-15: commits `80c4279` (relay) + `714dcf5` (app) + `fd6502e` (e2e flow 187);
   founder key signup is the only remaining step** (see Partner-key infrastructure above).
5. DFX registration decision after (2)–(3) proven live (founder B2B contact gates it).
6. ~~ckBTC registration only on depth improvement~~ — **FIRED and consumed 2026-09-16** (pool
   re-measured ~2× deeper; registered `88dada5`); ckSOL watch (`icrc1_name` on
   `la34w-haaaa-aaaar-qb5na-cai`) stays — the mainnet canisters are still the devnet variant;
   KongSwap rejected with evidence above.

Regulatory posture is unchanged: officials/counsel confirmation of the delegated-conversion
frame remains founder-owned (spec §After PoC) — this research adds venues inside that same
frame, it does not alter it.
