# 2026-09-07 — First-run and rail-disclosure UX decisions

**Status: RECONSTRUCTED, NOT TRANSCRIBED. Founder confirmation owed.**

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

## 2. The first-run chooser pre-selects nothing

`HomeCurrencyChooser` opens with no currency picked and Continue disabled until the user taps a row,
replacing a pre-selection of the first offerable currency.

Why the code says so: the pre-selection made one tap commit a default the user never chose, on a
setting that decides the default asset, the headline number, and the unit prices are read in.

## 3. The first currency choice lands the wallet on Home

Committing the chooser sets the wallet's mode to `home` (`Wallet`'s `onChoose`), instead of
inheriting the standing Pay-scanner landing.

Why the code says so: a wallet one tap old has nothing to scan and no funds to pay with, so the
scanner opened on a fund gate. Home is where the chosen currency, its balance, and Add money are.

**This is the entry that most needs confirming.** It narrows the standing scanner-stays-the-landing-
screen decision (`CLAUDE.md`, top priority §4) to every launch after the first. The code treats that
as a narrowing, not a repeal — but the founder set that rule and only the founder can say so.

## 4. The rehearsal is a two-phone DEMO practice guide, not a story about a shop

The rehearsal's three steps now instruct the user through a real ∂1 DEMO payment between two
phones, and its closing line states that DEMO has no cash value and that the walkthrough never asks
for a deposit or a purchase. Its primary action reads "Choose my currency" — which is where it now
goes. The offline-settlement truth it used to carry moved to walkthrough scene 1.

Why the code says so: the old copy narrated a payment the user was not making, next to a button
labelled "Try with demo funds" — a solicitation shape on a screen that funds nothing. The copy
contract is `app/config/education.ts`.

The same reframe reached the create path in `app/components/Onboarding.tsx` and
`M.onboarding.demoNote` / `demoGlyphNote`.
