# The currency-first wallet — CHF/EUR/USD, on whichever rail serves the user best

**Founder direction taken 2026-09-04. This is the top of the backlog.** Except for the slices
recorded as landed — O1 under "What landed" at the end, O2 in its own section — every verb below
is a roadmap verb, deliberately. What is deployed lives in `OPEN_ISSUES.md`, and per-asset
availability lives in `positioning.md` — neither is restated here.

## What the brief was, and what measurement did to it

The ask was: make CHF the main currency, configurable by the user at onboarding between CHF, USD and
EUR; add funds with a card; think about swap venues; look like Revolut.

Measuring it changed the shape of the answer twice, and both changes are load-bearing.

- **EUR's obvious Internet Computer candidates are dead.** Not thin — dead.
- **No card on-ramp in the world delivers any Internet Computer asset except native ICP.** Not VCHF,
  not ckUSDC, not ckBTC, not ckETH.

Together those force a conclusion the brief did not anticipate: **a currency is not an asset. It is a
set of rails, and which rail serves a user best differs by what they are trying to do.** VCHF on the
Internet Computer is the one with a bank on-ramp; VCHF on Solana is the one with liquidity and a card
route. Choosing one and deleting the other loses something real either way.

## Founder decisions, 2026-09-04

1. **A currency spans rails, and dpay picks the better one automatically, on price.** CHF is
   `VCHF@InternetComputer` *and* `VCHF@Solana`; the wallet selects between them for the user rather
   than making them learn the difference. The boundary this must not cross is below and is not
   negotiable.
2. **EUR is EURC on Solana.** Circle-issued and MiCA-licensed. The IC alternatives were measured and
   rejected: `positioning.md`.
3. **Card funding lands stable value, and any conversion is a transaction the user signs**, with
   dpay taking no cut. Multiple on-ramp rails, not one provider. **Conditional on legal
   acceptability — that condition is unresolved and is the gate on objective 3.**
4. **Revolut is the visual and IA reference; the scanner stays the landing screen.** The product is
   tap-to-pay abroad and the tourist's first gesture is scanning, so the balance home is one tap
   away rather than in front of it.

## The measured world — funding and conversion venues

Every row measured 2026-09-04 against a live API, a live canister query, or a live RPC. Asset
availability *per se* belongs to `positioning.md`; this table is about the venues, which that
document does not own.

### Conversion depth, by venue

| Route | Venue | Measured |
|---|---|---|
| VCHF → ckUSDC, direct | ICPSwap `hx7nb-diaaa-aaaar-qbxsa-cai` | **Saturated.** 100 VCHF → 122.05 ckUSDC; 1 000, 10 000 and 100 000 VCHF **all** return the identical 384.84 ckUSDC. Tradeable depth ≈ CHF 315. |
| VCHF → ICP → ckUSDC | ICPSwap, two hops | Works. ≈0.6% at retail size, ≈2.3% at 10 000 VCHF. Two approvals, two calls. |
| VCHF → USDC | Jupiter, Solana | 10 000 VCHF → 12 321.92 USDC, **0.21% impact**. 1 000 VCHF → 0.012%. |
| EURC → USDC | Jupiter, Solana | 10 000 EURC → 11 615.39 USDC, **0.04% impact**. |
| Solana USDC ↔ ckUSDC | — | **No non-custodial path exists.** ckSOL is reserved but codeless (minter `lh22c-kyaaa-aaaar-qb5nq-cai` and ledger `ls5lp-lqaaa-aaaar-qb5oa-cai` both report `Module hash: None`), and no major bridge supports the IC. |

Float, for the concentration risk it implies: VCHF on the IC is 332 278.77, of which the VCHF/ICP
pool holds ~59%. VCHF on Solana is 1 073 381.66 — 3.2× larger.

### Fiat on-ramps

| Path | Provider | Measured |
|---|---|---|
| CHF/EUR **bank** → VCHF@IC | DFX.swiss | Live. CHF 100 → 96.51 VCHF (1.49% + CHF 2 fixed), min CHF 10. **Keyless prefilled widget; the user authenticates with their own key and contracts with DFX AG** — there is no destination-address field, so the asset goes to the account that authenticated. Full KYC. Swiss sale approval only. |
| CHF/EUR/USD **card** → USDC/SOL | Coinbase Onramp, Transak, MoonPay, Ramp, Banxa, Mercuryo, Onramper | Live everywhere. Coinbase Onramp is free to integrate; Onramper is US$199/mo. |
| Card → native ICP | Coinbase Onramp (`dfinity`), Onramper (`icp_icp`) | Live; the **only** card route to the IC. Delivers to the legacy 64-hex account identifier, not a principal — `AccountIdentifier::from_principal` already exists in `crates/dpay-icp`. |
| Card → VCHF / ckUSDC / ckBTC / ckETH | — | **None. Anywhere.** Nine providers' live catalogues checked; zero occurrences. |

DFX is card-less across its entire product, not just for IC assets, and has no sandbox — the
smallest real proof is a CHF 10 bank transfer.

## The four objectives

### O1 — the money the user thinks in

A home currency, chosen at onboarding and changeable in Settings, from **CHF · USD · EUR**. It sets
the wallet's default asset, the big number on the home screen, and the unit a till's price is read
in. The founder's own default is CHF.

**BUILT 2026-09-04 — see "What landed".** It was new plumbing rather than a rename: no
home/primary/preferred currency existed in any form, and the active asset was not even persisted
across launches.

### O2 — a currency is a set of rails, and dpay picks one

`CHF` resolves to `VCHF@InternetComputer` or `VCHF@Solana`; `USD` to `ckUSDC@InternetComputer` or
`USDC@Solana`; `EUR` to `EURC@Solana` — since the 2026-09-06 founder decision, `EUR` to BOTH rails
(`EURC@Solana` and `VEUR@InternetComputer`; see the addendum below). The wallet chooses per
operation, on measured cost, and tells the user which rail it chose and why.

**LANDED 2026-09-05, app-only, five commits (`3d44de1`→`470b0b6`) — not deployed; deployment state
lives in `OPEN_ISSUES.md`.** The group is the model, purely in `app/config/currency.ts`: `railFees`
states each rail's fee as a fact in the rail's own unit; `chooseRail` is the policy — destination →
funded → preference, first match wins — returning a reason with the rail; `railsLabel` names the
whole group on one line. Around it: the chooser and Settings list every rail of the group with the
preferred rail's reason; Balances badges every sibling rail, MAIN stays on the preferred one, rows
are never merged and there is no group sum; Receive defaults to the chosen rail and discloses both
rails' addresses and fees (`RailDisclosure`), and `IcrcDepositSheet` names the settlement chain
(ckUSDC no longer says "Ethereum"); SendSheet's route line names the rail and its fee; the
funded-sibling pointer on all four fund gates switches via lock-gated `payRailSelect` — a user
gesture, never a side-effect. Never-override is pinned: `app/__tests__/rail-choice-isolation.test.ts`
(structural — no pinned surface, `resolvePayLink`/OpenCryptoPay/Solana Pay/wire, may import or call
the chooser) plus e2e flows 123 (a named-rail link pays the named rail exactly) and 124 (pointer +
one-tap switch). Fees stay facts in their own units — no cross-token comparison anywhere; that would
be an FX quote and waits on O3's legal decisions. New e2e flows 120–124; the default suite runs 119
GREEN, `FLOWS.md` carries 120 rows. Objectives 3 and 4 remain not started.

#### Addendum 2026-09-06 — the EUR dual-rail, landed

**Founder decision 2026-09-06: EUR spans BOTH rails — VEUR on the Internet Computer *and* EURC on
Solana.** This supersedes two things this plan said: decision 2's "EUR is EURC on Solana"
single-rail shape, and the "VEUR is not in the catalog and must not be added" line under "What this
costs in code" (struck there). Landed as three commits — `0ab1881` (catalog data), `b2f3998`
(Solana engine generalization), `351952b` (rail-health UI):

- **VEUR@IC** — currency 9, ledger `wu6g4-6qaaa-aaaan-qmrza-cai`, 8 decimals, fee 10 000 e8s
  (0.0001 VEUR): a complete **no-minter direct-ICRC row in exactly the VCHF/ICP shape** (payment is
  an app-signed `icrc1_transfer` straight to the ledger). Liquidity **`thin`** — on-chain supply is
  a verified stub (~1.5 VEUR total). DFX lists VEUR sellable-not-buyable, encoded as the catalog's
  first `offramp = Partner` row (`ramp_partner: "DFX"`); onramp stays `Unavailable` (no compliant
  fiat rail in). The payment unit is the issuer token "VEUR", never "EUR" — the same rule as
  VCHF/CHF. **Cap flag:** the row's payment-policy cap `1_000_000_000_000` e8s = 10 000 VEUR
  mirrors VCHF's shape and **awaits founder confirmation**.
- **EURC@Solana** — Circle mint `HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr`, 6 decimals, the
  legacy SPL Token program (not Token-2022). Liquidity **`deep`** (~105M circulating). No fiat ramp
  through dpay — honest `Unavailable`.
- **Liquidity is DATA, not prose.** `liquidity: 'deep' | 'thin'` is an optional field on catalog
  rows; absent = no statement, and old rows serialize byte-identically — the wire shape is
  relay-pinned. Both parsers (relay + app) fail closed to null on anything unexpected.
- **The Solana engine was generalized off USDC-hardcoding.** `app/solana/tokens.ts` is the pure
  per-mint registry (SOL/USDC/EURC; `spl.ts` re-exports the USDC consts — no second source);
  balances, fund gates, and ATA setup are per-mint. USDC goldens are byte-stable.
- **UI.** A chooser **detail step** for multi-rail currencies: tapping the EUR row expands an
  in-card panel — per rail, the chain tag, the fee in its own unit, the liquidity line, the ramp
  fact, and the default-pick reason on the preferred rail only (EURC leads because its liquidity is
  catalogued deep while VEUR's is thin); single-rail currencies confirm as before, and the
  `home-currency-*` / `btn-home-currency-continue` surfaces are byte-stable. A shared
  `RailLiquidityNote` (one testID) renders the catalog's liquidity statement on Balances rows, the
  receive disclosure, and the fund gates — `thin` warns everywhere it appears; `deep` renders only
  in the detail step.
- **NOT deployed.** The rows appear app-side from the bundled mirror; the relay serves them only
  after the founder's `just up` (prod measured at `a913c6d`, pre-EUR, 2026-09-06 — deployment state
  in `OPEN_ISSUES.md`).
- **E2E.** Flows 129–132 new (rail detail · Balances rails · receive rail · EURC Solana Pay); 118
  inverted (EUR is present — the chooser offers CHF/USD/EUR); 120 extended (the EUR group). Suite
  123/123 GREEN; `FLOWS.md` carries 124 rows (supersedes the counts above).

### O3 — funding: card and bank, several providers

Add money offers whatever actually works for the chosen currency, and says which is which: a card
route landing stable value, and a bank route landing the currency directly where one exists (CHF via
DFX). Conversion, where needed, is a transaction the user signs on-device.

**Gated on the legal question in "Open", below.** The card→stable half is not gated and can proceed
independently.

### O4 — Revolut-grade UI

Revolut is the golden reference for the visual system and information architecture: a balance-first
home with an action row, inline accounts, and an inline activity feed, over a persistent bottom tab
bar — replacing today's three top pills and the Balances modal. The scanner stays the landing
screen.

## The boundary — what automatic rail selection may and may not do

This is the rule that keeps decision 1 inside the non-custodial / no-swap non-negotiable
(`CLAUDE.md`). It is a rule about **when two options are the same currency**.

**Allowed — this is routing between identical units, not exchange:**

- Choosing which of the user's own CHF balances to spend, when the destination accepts either.
- Choosing which rail to receive on, or to fund into.
- Comparing the all-in cost of two rails for the *same* currency and preferring the cheaper. Both
  legs are francs; there is no rate between them and no price risk to take.

**Refused:**

- Overriding a merchant's named settlement asset. The merchant's request names the asset, the payer
  pays exactly that, and a wrong-rail payment is refused rather than redirected — the rule that
  already governs payment links (`resolvePayLink`, `app/config/assets.ts`).
- Selecting between *different* currencies on price. That is FX, and it is exactly what dpay does
  not do.
- Presenting a converted total across unlike assets. The home screen's big number is the home
  currency's **own balance**, never a synthetic portfolio sum — which also means it needs no quote
  source and no rate.

**The honest edge:** VCHF@IC and VCHF@Solana are both "CHF" to the user but are different tokens
from the same issuer, and the user cannot move value between them inside dpay (no non-custodial
bridge exists — measured above). The UI must never imply they are one balance. The precedent for
distinguishing them already exists: `chipLabel` qualifies colliding symbols with a network tag.

## What this costs in code — the parts that are known now

- **No home-currency concept exists.** New persisted preference; the existing template is the
  theme/locale pattern lifted into `App.tsx` (key in `app/config/constants.ts`, a pure
  parse/resolve module, a batched mount read, a set-and-persist mutator, props threaded to
  `SettingsSheet`).
- **The active asset is not persisted at all** and is re-derived to DEMO each launch
  (`reconcileSelectedAsset`, `app/config/assets.ts`). A home currency changes that policy.
- **`AssetId` is a closed union** — `` `ic:${number}` | 'solana:SOL' | 'solana:USDC' ``
  (`app/lib/types.ts`). Adding VCHF and EURC on Solana means generalising the Solana rail from two
  hard-coded tokens to a mint-keyed catalog, including the single-mint assumption in
  `app/solana/spl.ts`.
- ~~**VEUR is not in the catalog** and must not be added; EURC is a Solana row, not an IC one.~~
  **SUPERSEDED 2026-09-06: both EUR rails are catalogued — see the O2 addendum.**
- **The e2e preamble is the big mechanical cost.** `onboardWallet` waits on `∂100.00` in the header,
  which is only true if the landed asset is DEMO; 106 of the flows go through it. A new onboarding
  step and a non-DEMO default both land here.
- **DEMO's identity is encoded three separate ways** (`currency === 0`, `mintable === true`,
  `assetTestKey === 'demo'`), so "DEMO is no longer the default" and "DEMO is no longer special" are
  separable changes and should be done separately.

## Open

- **The legal question, and it gates O3's conversion half.** Whether dpay may display a rate and
  select a venue — even taking no cut — is founder decisions 1 and 2 in `positioning.md`'s
  conversion subsection, and they are not taken. Taking no cut removes the monetization ambiguity
  but not the routing one: picking the provider and showing a rate is the part with legal weight,
  independently of revenue. Note the same activity test already flagged for the relay under MiCA.
- **Which card provider.** Coinbase Onramp is free to integrate and reaches native ICP; Onramper
  aggregates several at US$199/mo. Neither has been driven end to end.
- **Whether any provider accepts an ICRC-1 principal** rather than the 64-hex account identifier is
  undocumented everywhere and is a funds-losing risk. Settle it with one small real purchase before
  promising a card route to the IC.
- **VCHF issuer risk applies identically on both rails**; what must be said whenever VCHF is named
  is owned by `positioning.md`'s CHF row. One consequence belongs here because it kills a design
  option: VNX's integration terms make the integrator the customer of record ("you are not minting
  on behalf of your own end-users"), with a CHF 100 000 redemption floor, so **there is no path
  where a dpay user contracts with VNX directly** and issuer-level mint/redeem is not available as
  a funding rail.
- **The Solana offline tap has never crossed a radio** (`OPEN_ISSUES.md`). Moving fiat-denominated
  currencies onto Solana raises what that gate is worth, without changing what it is.

## What landed 2026-09-04 — objective 1, and only objective 1

Built, green on every inner-loop gate (tsc clean; jest 84 suites / 1698; e2e **113/113** incl. the
new flow 118; `just test-relay` 88/88; `dpay-core` 32/32). Not deployed — `OPEN_ISSUES.md` carries
deployment state.

- **`app/config/currency.ts`** — the home-currency domain, pure and unit-tested
  (`app/__tests__/currency.test.ts`): a currency resolves to the rails the live catalog carries, in
  a stated preference order, and is only OFFERED when a rail exists. EUR is therefore absent from
  the chooser today and will appear on its own the day an EURC row ships.
- **The first-run chooser** (`app/components/HomeCurrencyChooser.tsx`) gates the wallet whenever no
  currency is stored — one path for a new wallet and for one upgrading into this build.
- **The wallet opens in the chosen currency.** `reconcileSelectedAsset` takes the home rail as an
  explicit third argument, ranked between "keep what's selected" and the old DEMO default.
- **The header names the currency, the amount keeps the token.** "Swiss francs · Main" over
  `0.00 VCHF` — never `CHF 0.00`, because VCHF's peg is the issuer's claim.
- **The accounts list marks the main currency** with a MAIN badge (light + dark baselines reseeded).
- **Settings owns the change** (`Main currency`, above theme/language — a money preference outranks
  presentation ones).
- **The selection is now remembered** (`dpay.selectedAsset.v1`). A reload or a `?screen=…` deep link
  resumes the asset the user was on instead of resetting; a choice made in the session outranks the
  remembered one, which is a precedence rule rather than a race.

Three defects this work surfaced and fixed, each worth keeping in mind because each was a claim the
UI made that was not true:

1. The chooser said **"Held as USDC on Ethereum"** for ckUSDC — display glyph plus backing chain.
   It settles on the Internet Computer, and someone could have sent Ethereum USDC to an IC
   principal on the strength of it. Rails are now labelled by ledger token + settlement chain.
2. The offline **"approx." marker disappeared** once the header named the currency, so a stale
   balance would have read as authoritative. Caught by flow 100; the offline branch now outranks the
   main-currency label.
3. The chooser's own render **latched DEMO** before the user's choice arrived, so the wallet opened
   on DEMO whichever currency was picked. The selection effects are inert while the gate is open.

**Explicitly NOT built in this slice:** objectives 2, 3 and 4 — O2 landed the next day; see its
section. In particular the Revolut IA
itself — a bottom tab bar, inline accounts and an inline activity feed on the home surface — is
untouched; what landed is the currency model those surfaces will display, plus the MAIN badge on the
existing Balances sheet. The scanner remains the landing screen (founder decision).

**The one harness change worth knowing about:** a wallet no longer opens on DEMO, so the shared e2e
preamble answers the currency question and then selects DEMO explicitly (`chooseHomeCurrencyIfPresent`
+ `selectDemoAsset` in `e2e/harness/lib.mjs`). Flows whose subject IS the demo rail say so; flow 118
is the one that keeps its currency and checks what it bought.
