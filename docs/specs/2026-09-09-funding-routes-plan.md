# Naming a funding route the user can actually follow

**Founder direction taken 2026-09-09.** Every verb describing the screen below is a roadmap verb
until the "What landed" section says otherwise. What is deployed lives in `OPEN_ISSUES.md`; the
*shape* of Add money lives in `FUNDING.md`; per-asset availability lives in `positioning.md`. None
of the three is restated here.

## The problem, stated exactly

The app's only honest funding instruction today is *"send VCHF from an Internet Computer wallet"*.
The target user is a traveller who does not have an Internet Computer wallet, has never heard of
one, and is given no route to getting one. Every path in the app — Pay, Convert, Add money,
Receive — converges on that same instruction. It is a complete sentence and a dead end, and it
arrives at the exact moment a new user decides whether the product is real.

This is not the card-ramp objective (`OPEN_ISSUES.md` item 1), which is hard-blocked on counsel.
It is the gap that objective leaves uncovered in the meantime, and closing it needs copy and a
founder decision, not a licence.

## The founder decisions, 2026-09-09

1. **Name several providers, unranked, with fees.** Not one provider (that is routing discretion),
   not zero (that is the dead end restated politely).
2. **Present card → native ICP → in-app Convert → VCHF as a funding route.** Every piece of it
   already exists; see "Why this path is the unlock" below.
3. The screen takes **no referral commission and no cut** from any provider named.

### Why decision 1 is inside the regulatory checklist

`docs/REGULATORY.md` §4 is the operational checklist and it is not restated here. The four items
this screen is measured against, and how it satisfies each:

| §4 item | How the screen complies |
|---|---|
| 4 — never label a route "best" | No ranking, no "recommended", no default selection. Order is alphabetical, which is a rule rather than a preference. |
| 5 — let the user choose the venue | Several providers, every one reachable by the same gesture. dpay expresses no view on which. |
| 6 — take no venue-paid compensation | No referral links, no affiliate parameters, no revenue share. Decision 3 above. |
| 7 — relay the provider's own rate, attributed and timestamped; never compute or blend one | The screen shows each provider's **own published fee range**, attributed by name, carrying the date it was read and a link to the source. Nothing is averaged, summed, or ranked across providers. |

The licence question is not triggered by naming routes. It is triggered by picking one, ranking
them, or taking a cut — none of which this screen does.

## What measurement did to decision 1

The decision was "with fees", meaning a number per provider. **Not one of the four publishes a
comparable number.** One publishes flat rates, two publish caps and floors, one publishes nothing
per method at all — and three of the four take a spread that is not counted as a fee. Read
2026-09-09 against each provider's own published disclosure:

| Provider | Published fee | Spread disclosed separately? | Source read 2026-09-09 |
|---|---|---|---|
| Coinbase Onramp | 2.5% card, 0.5% ACH | Network fee charged on Coinbase's own estimate; Coinbase states it keeps no part of it | `docs.cdp.coinbase.com/onramp/additional-resources/faq` |
| MoonPay | **up to** 4.5% card, from 1% bank transfer; minimum fee up to $3.99 direct / $4.50 partner-referred | **Yes — spread is baked into the displayed asset price**, stated as such | `moonpay.com/legal/pricing_disclosure` |
| Ramp | **up to** 3.9% card (USD/EUR/GBP), **up to** 5.45% card (other currencies), **up to** 1.40% manual bank transfer; minimum up to €2.49 | Not quantified | `rampnetwork.com/pricing-policy` |
| Transak | **No single published figure for either method** — rates are per-corridor. Its docs contain a 0.99% + €0.59 SEPA *worked example*, which is not a published rate and is deliberately NOT shown as one. | **Yes — quoted rate is CoinGecko mid plus a 2.5% spread**, stated as such | `support.transak.com/en/articles/7845942` |

**So a single percentage per provider would be a false claim in two independent ways:** it would
present a ceiling as a price, and it would omit a spread that in Transak's case is larger than
some of the fees being quoted. There is a third, found while building it: a *shape* per figure is
also needed. Coinbase publishes 2.5% flat, MoonPay publishes "up to 4.5%" and "from 1%", and
Transak publishes no figure at all — the first implementation collapsed these into one boolean and
rendered Coinbase's flat rate as "from 2.5%", which is a different claim and a false one. The code
models `flat` / `cap` / `floor` / `varies` for exactly this reason (`app/config/funding.ts`).

`CLAUDE.md`'s external-claims non-negotiable ("never overstate the present") governs in-app copy
exactly as it governs an investor email, which is why each of these is a defect and not a nuance.

**What the screen therefore shows per provider:** each figure in the shape it was published in —
"up to" preserved where the provider uses it, "from" where it publishes a floor, the bare figure
where it publishes a flat rate, and *varies by country* where it publishes none; the spread named
where the provider discloses one; the date every figure was read; and one sentence true of all
four — *your exact fee is shown before you pay, and most providers also take a margin inside the
rate they quote*. Where a figure cannot be read from a primary source, the row says so rather than
carrying an estimate.

**Staleness is a defect, not a caveat.** These figures are provider policy and will drift. The
re-check obligation is recorded under "Tripwire" below; a row whose date is stale is a bug in the
same sense a red gate is.

## Which providers are named, and why those

The inclusion rule, stated so the selection is a rule rather than a preference (§4 item 5):

> A provider is named if it (a) delivers an asset this wallet holds, (b) to a destination address
> the user supplies, (c) accepts a consumer card or bank transfer, and (d) has no commercial
> relationship with dpay of any kind.

Four providers satisfy it as measured 2026-09-04 (`2026-09-04-currency-first-wallet-plan.md`,
which owns the venue measurements): Coinbase Onramp, MoonPay, Ramp, Transak. Banxa and Mercuryo
also satisfy it; they are omitted for screen length, and that omission is a presentation choice
rather than a judgement about the providers — it must never be described to a user as a shortlist,
a selection, or a recommendation.

## Why the ICP → Convert path is the unlock (decision 2)

The measured constraint that makes CHF hard: **no card on-ramp anywhere delivers VCHF, ckUSDC,
ckBTC or ckETH** — nine providers' live catalogues checked 2026-09-04, zero occurrences — and
native ICP is the only card-reachable Internet Computer asset. A Swiss bank transfer through DFX
reaches VCHF directly, but it is Swiss-sale-approved only and takes bank-transfer time, which is
not a traveller's route.

That leaves one complete path from a card to francs, and every leg of it already exists:

1. Buy native ICP with a card (Coinbase Onramp or Onramper — the only two, measured 2026-09-04).
2. Withdraw to the wallet's own ICP account identifier. The app already derives and displays it.
3. Convert ICP → VCHF in-app: the user's own device signs `icrc2_approve` + the pool call. The
   route is live and measured — 1 ICP → 2.41771929 VCHF on the production relay, direction derived
   from the venue's own metadata (`OPEN_ISSUES.md` work-order item 2).

**The condition attached to decision 2.** This places a user-signed swap inside the funding path a
new user walks. Whether that screen is a *Zusatzleistung zur Auslösung oder Durchführung von
Zahlungen* under AMLO Art. 4(1)(b) is counsel question 1 in `docs/REGULATORY.md` §7 and is
unanswered. The founder took this decision with that stated. If counsel answers no, the funding
screen loses this route and CHF users fall back to bank transfer — the rest of the screen is
unaffected, so the dependency is contained to one card.

## What the screen must not become

- Not a widget, not an embedded provider, not a deep link carrying dpay's address into a provider
  flow. That is the next increment and it is a separate decision — it is routing discretion under
  §4 item 5 and the founder asked for counsel on it before it is built.
- Not a rate quote. dpay computes no price for anything on this screen.
- Not a place where any provider is default, pre-selected, highlighted, or listed first for a
  reason other than the alphabet.

## Tripwire

The four fee rows are policy figures read on a date, so they need an owner and a cadence rather
than good intentions. The check: re-read each provider's published disclosure and diff against the
table above. Any drift is a copy fix in the same change. This obligation is filed in
`OPEN_ISSUES.md`; it is not repeated in the app.

## What landed

**The section itself, 2026-09-09.** `app/components/FundingRoutes.tsx` renders on the VCHF and
native-ICP deposit surfaces (`IcrcDepositSheet`), driven by the pure resolver + provider table in
`app/config/funding.ts`. Proven in a browser by e2e flow 162: VCHF names the buy-ICP-then-convert
route, native ICP is a direct buy, the "up to" qualifier survives to the screen, and the
attribution and non-endorsement lines render. Unit coverage: `app/__tests__/funding.test.ts`.

**Not yet wired:** the ckBTC (`DepositSheet`), ckETH/ckUSDC (`CkErc20DepositSheet`) and Solana
(`SolanaReceiveSheet`) surfaces. Those three take a currency id rather than a `SelectableAsset`, so
each needs the asset and the home currency threaded through first. The resolver already answers for
them correctly (`fundingRoute` covers every family, and its tests pin the chain-key and testnet
cases) — only the wiring is outstanding. Tracked in `OPEN_ISSUES.md`.

Deployment state, as always, lives in `OPEN_ISSUES.md` and not here.
