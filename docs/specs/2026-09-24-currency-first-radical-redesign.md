# 2026-09-24 — Currency-first radical redesign + swap as a first-class action

**Status:** founder objective, recorded verbatim this day. Open forks at the end are with the
founder (questions sent 2026-09-24); the build follows the verbatim text plus the answers.

## The objective, verbatim (founder, 2026-09-24)

> Let's finish the swap support in the app. We should have all the pieces now. For each currency
> we should have balance and a button "Convert". E.g.
>
> ```text
> <Icon/Flag>  <CurrencyName, e.g. Swiss Frank>            4,54 Fr
> -- || --
>
>
> [Add new currency]
> ```
>
> Clicking on one of the existing currencies sets the clicked currency as the "main" currency.
> Clicking on add new currency opens the long list of currencies, where at the top there is a
> search field. The list is split into stable currencies and other. We should have a list of all
> support crypto and stable currencies.
>
> After a currency has been selected, user is shown the home screen. The home screen has:
>
> ```text
>            Balance <currency>
>   [large font] 4,54 Fr
>
> [Add funds]  [Convert]  [Withdraw funds] [...]
> ```
>
> the [...] shows a few entries for now: Transaction list, Remove, more in the future
>
> Add funds will be on-ramping, Withdraw funds will be off-ramp, Convert will be swap.
>
> Swap screen:
>
> ```text
> <Source currency>             <amount sell, user enter>
> <Source balance>
> ---------------------------------------
> <Target currency>             <amount get, calculated>
> <Target balance>
> ```

## What this is

"Finish the swap support" is delivered by making **Convert a first-class action of every
currency** inside a **Revolut-style currency-first IA** (Revolut stays the golden reference for
visual system and information architecture, 2026-09-04 direction). All the machinery exists:
the delegated-conversion engine (`app/convert/` — ICPSwap pools, SideShift/Trocador CeFi through
the relay's partner-key proxy, CCTP, Jupiter on SOL), the funding-routes on-ramp surface
(2026-09-09 plan), the withdraw/off-ramp surfaces, and the currency-grouped accounts route.
This redesign re-arranges them; it does not rebuild them.

## The screens

1. **Currency list** (evolves the accounts route). ONE row per CURRENCY — flag/icon, currency
   name, balance, and a **Convert** button — with **[Add new currency]** at the bottom. Entry
   points stay as they are (home headline tap, header chip, `a` hotkey).
   - Tapping a row sets that currency as the wallet's **main** currency and shows Home.
   - A row's **Convert** opens the swap screen with that currency as the source.
2. **Add new currency.** The full supported-currency list: search field at the top, split into
   **Stable currencies** (CHF, USD, EUR) and **Other** (BTC, ETH, ICP, SOL). Practice money keeps
   its separated practice slot; testnet stays behind its existing toggle.
3. **Home.** Eyebrow `Balance <currency>`, the balance in large font, and the action row
   **[Add funds] [Convert] [Withdraw funds] [...]**.
   - **Add funds = on-ramp** (the funding-routes surface).
   - **Withdraw funds = off-ramp** (the existing withdraw surface today — on-chain out; partner
     off-ramps land in this entry when the legal blockers clear).
   - **Convert = swap** (the existing delegated-conversion engine).
   - **[...] menu:** Transaction list, Remove (more entries later).
4. **Swap screen.** Source currency + sell amount (user enters), divider, target currency +
   receive amount (calculated from the venue quote), each side showing its balance.

**One main currency.** Home-currency and selected-asset merge: the wallet is "in" exactly one
currency; which rail of that currency carries value is resolved by dpay (the 2026-09-04
objective-2 model — a currency is a set of rails, dpay picks one for the user).

## Standing rules this redesign supersedes (founder's own, by this directive)

- **X4 headline tap-protection** (2026-09-08): tapping a currency in the list is now the
  deliberate gesture that sets main — selection is the point, not a stray tap.
- **Settings-only home-currency change**: the list tap sets main.
- **The 2026-09-14 three-equal-cards Pay/Receive/Add-money action row**: replaced by
  Add funds / Convert / Withdraw funds / [...].

## Open forks (questions sent to the founder 2026-09-24 — build follows the answers)

1. **Pay and Receive after the redesign** — bottom tabs unchanged, or reshaped?
2. **A multi-rail currency row's balance** (CHF = VCHF·IC + VCHF·Sol, USD = ckUSDC·IC + USDC·Sol)
   — one summed currency number, main rail only, or main + sibling sub-row?
3. **Venue choice in the swap screen** — the 2026-09-11 rule is the user picks from side-by-side
   venue quotes, none preselected; the sketch implies dpay resolves and the venue is disclosed at
   confirm. Which wins?
4. **The balance unit** — the sketch writes `4,54 Fr`; the standing honesty rule says the currency
   is the label and the token is the unit (`4.54 VCHF`, never `CHF 4.54` — VCHF's peg is the
   issuer's claim). Which wins?

**Proposed Remove semantics** (not a question unless the founder corrects it): Remove hides the
currency from the wallet's list (device-persisted, re-addable from Add new currency); refused
with a practical explanation while the currency holds a nonzero balance, and the last currency
cannot be removed.

## What does NOT change

- **The no-swap non-negotiable.** Convert stays DELEGATED conversion: the user's own device
  signs, the venue's own quote is shown attributed + timestamped, dpay takes no cut, holds
  nothing, and has no exchange credentials.
- **The pre-sign transparency checklist** (counterparty, fees per line, minimum-you'll-receive,
  failure branches) — it lives behind the swap screen's confirm, not on it.
- **The uniform-IA hard rule**: every currency, every rail, through the same surfaces.
- **The honest-instruction rule** on every screen and error path (2026-08-29).
- **The offline-pay rails** (IC NFC v2, SOL recent-blockhash v2) — untouched.
