# 2026-09-07 — First-run and rail-disclosure UX decisions

**Status: RECONSTRUCTED, NOT TRANSCRIBED — then ADJUDICATED 2026-09-08 by three independent
reviewers.** The founder's instruction was: *"you make the UX review with dedicated fresh subagents
(swarm) and their consensus, adjust the docs accordingly."* Three reviewers drove the LIVE deployed
build with separate browsers and no sight of each other's findings — a newcomer/scam lens, a
returning-user/efficiency lens, and an information-architecture lens. Their verdicts are recorded
under each decision below as **SWARM VERDICT**. Where they split, the split is stated rather than
averaged away, and the call I made is given with its reason.

The wider defect inventory the swarm produced does not live here — it is filed with value/effort in
`OPEN_ISSUES.md` under "UX swarm 2026-09-08".

**Status of the four originals: RECONSTRUCTED, NOT TRANSCRIBED. Founder confirmation still owed on
the reasoning; the swarm can adjudicate the design, not what was in the founder's head.**

This record was written *after* the change, by reading the code, because the change shipped with no
decision document and the only 2026-09-07 spec in the repo
([`2026-09-07-delegated-conversion-spec.md`](2026-09-07-delegated-conversion-spec.md)) covers an
unrelated subject. Nothing below is a quote, a paraphrase of anything the founder said, or a record
of a conversation — each entry states what the code now does and the reason the code itself gives.
Where a decision reverses something an earlier spec had written down, that is named.

**Founder: confirm or correct each of the four. Any entry you do not recognise is a defect in the
code, not a defect in this record.**

## 1. A pure preference is never disclosed as a reason

`chooseRail` still ranks rails `destination → funded → preference` and still returns `preference`
as its last-resort reason, so rail ORDER is unchanged. What changed is that the three surfaces that
render a reason now suppress that one: `HomeCurrencyChooser` (both the collapsed row and
`RailGroupDetail`) and `RailDisclosure`. The message for it is deleted from all four locales, so
`M.wallet.homeCurrency.railReason` carries only the two actionable reasons.

Why the code says so: `destination` and `funded` are facts about the user's own payment or balance —
they answer "why this one?" with something the user can check or act on. `preference` answered it
with "because dpay prefers it", which adds a sentence without adding information.

Reverses: [`2026-09-04-currency-first-wallet-plan.md`](2026-09-04-currency-first-wallet-plan.md),
which specified the preferred rail's reason unconditionally.

**SWARM VERDICT: CHANGE — right intent, wrong execution. Two of two reviewers who examined it,
independently.** The intent ("because dpay prefers it" is not information) is agreed. Two measured
consequences it did not anticipate:
1. **On the screen it was written for, a reason now renders NEVER.** At first run every reason is
   `preference` — a new wallet has no destination and no funded rail, and the ∂100 faucet credit is
   DEMO, which belongs to no currency group. So the EUR detail panel lists both rails with fees,
   liquidity and ramp facts and **no sentence saying which one dpay will actually use**. The only
   population that can ever see a reason here is a funded wallet upgrading into the build.
2. **The slot outlived its content.** `receive-rail-why` now emits the rail's own NAME, so the
   Receive disclosure prints "Internet Computer" five times in ~120px, from an element whose testID
   is `why` and which answers nothing.
**The fix both reviewers converged on: state the fact that produced the preference — the catalog
already holds it.** EUR: "EURC circulates widely; very little VEUR exists on-chain." USD: the
reason already written in `app/config/currency.ts` — *ckUSDC because the Internet Computer rail is
the one whose offline tap is proven on physical hardware* — a checkable, product-differentiating
reason that is currently invisible to every user. Where no such fact exists, delete the slot rather
than restating the rail's name.

## 2. The first-run chooser pre-selects nothing

`HomeCurrencyChooser` opens with no currency picked and Continue disabled until the user taps a row,
replacing a pre-selection of the first offerable currency.

Why the code says so: the pre-selection made one tap commit a default the user never chose, on a
setting that decides the default asset, the headline number, and the unit prices are read in.

**SWARM VERDICT: SPLIT — one KEEP, one CHANGE — but unanimous on a defect neither the decision nor
this record mentions. Call: KEEP the no-preselect; FIX the dead end.**
- *Keep* (IA reviewer): this is the one setting objective 1 says the user chooses; pre-selecting
  CHF because it sorts first is dpay choosing it. The screen is a question, not a form.
- *Change* (newcomer reviewer): the remedy for an unconsidered default is a *reversible* default,
  not a dead button — and this setting is fully reversible in Settings ▸ MAIN CURRENCY. Pre-select
  from device locale.
- **Both measured the same defect: the disabled Continue swallows the tap in silence.** It renders
  at 40% opacity in the primary colour, looks pressable, and produces no response of any kind —
  no shake, no hint, no "pick one first". That is a dead end with no instruction, against the
  founder's 2026-08-29 hard rule, and it is independent of which way the pre-selection goes.
- I keep the no-preselect because the founder's own objective 1 makes this the user's choice, and
  a locale guess would be wrong for exactly the traveller this product is for. The dead end is a
  bug and is filed.

## 3. The first currency choice lands the wallet on Home

Committing the chooser sets the wallet's mode to `home` (`Wallet`'s `onChoose`), instead of
inheriting the standing Pay-scanner landing.

Why the code says so: a wallet one tap old has nothing to scan and no funds to pay with, so the
scanner opened on a fund gate. Home is where the chosen currency, its balance, and Add money are.

~~**This is the entry that most needs confirming.**~~ **SETTLED 2026-09-08: the founder repealed the
scanner-stays-the-landing rule outright** — the app opens on Home, Home becomes a real overview, Pay
is one tap. See [`2026-09-08-first-run-redesign.md`](2026-09-08-first-run-redesign.md) §1 F2.

**SWARM VERDICT: 2 KEEP / 1 NO — and the two who agreed both called it a hollow win.**
- Both KEEPs made the same point: the destination is right and Home has not yet earned it. Measured
  independently by both: the account list is **~80% of Home's scroll height** (1308/1652 px and
  1347/1691 px), the headline reads 0.00, and — the finding that matters most — **all four Home
  actions dead-end on the same node, "Show my VCHF address."** That is the scam shape stated as a
  graph rather than a feeling: every path converges on *give us money*, while ∂100 of spendable
  practice money sits one tap away and is never named.
- The NO came from the returning-user reviewer, and it is a real cost, measured: a reload lands on
  Pay today, so scan-to-pay is **1 gesture**; landing on Home makes it **2** — a 100% increase on
  the core gesture, paid on every payment.
- **The synthesis I am taking, which no single reviewer proposed alone:** honour the founder's
  direction AND keep the payer's gesture at one tap, by putting a persistent **Scan** affordance on
  Home. The dissenting reviewer named it as the mitigation that would make him withdraw the
  objection. Home becomes the landing; the checkout gesture stays one tap from cold start.
- A defect both KEEPs found that stands whatever the landing is: the wallet's "home currency" is
  silently overwritten by any account-row tap or receive-rail toggle, so the setting this decision
  exists to protect does not hold.

## 4. The rehearsal is a two-phone DEMO practice guide, not a story about a shop

The rehearsal's three steps now instruct the user through a real ∂1 DEMO payment between two
phones, and its closing line states that DEMO has no cash value and that the walkthrough never asks
for a deposit or a purchase. Its primary action reads "Choose my currency" — which is where it now
goes. The offline-settlement truth it used to carry moved to walkthrough scene 1.

Why the code says so: the old copy narrated a payment the user was not making, next to a button
labelled "Try with demo funds" — a solicitation shape on a screen that funds nothing. The copy
contract is `app/config/education.ts`.

**SWARM VERDICT: CUT. Unanimous, both reviewers who judged it, for the same reason.** Judged as
instructed against what a solo user with one device can do: **nothing on the screen is executable.**
All three steps begin with "the other phone"; the user has owned the app ninety seconds and knows
nobody with it installed. Its own primary button says "Choose my currency" — it does not offer to
do the thing it just described, so its structural completion rate is zero. And it contradicts the
app two taps later: it says *"choose DEMO, tap Pay"*, and the Pay tab — locked to the home currency
— answers *"No VCHF available."*
The reframe correctly diagnosed a solicitation smell and correctly deleted the fictitious shop. But
given "the copy describes something that isn't happening", the two branches were *stop describing
it* or *make it happen*; it took the first and landed on a screen describing something the user
cannot make happen either. **Replace it with a real one-device practice payment** (the design is in
[`2026-09-08-first-run-redesign.md`](2026-09-08-first-run-redesign.md) §3); if that is deferred,
delete the screen — first run is better six seconds shorter than with an unperformable instruction.
The two-phone guide keeps a home in Settings ▸ Learn, surfaced when the user first opens Receive.

The same reframe reached the create path in `app/components/Onboarding.tsx` and
`M.onboarding.demoNote` / `demoGlyphNote`.
