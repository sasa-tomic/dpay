# 2026-09-08 — First run: the user's first experience is a payment that works

Founder verdict that opened this, verbatim: *"the initial experience is VERY confusing. I get
greeted with several screens that just ask me to pay in some money. Looks like scam."* and *"greet
user with an introduction / walkthrough, maybe guide them through the send/receive money path with
the DEMO currency (vs their phone), and only then switch the currency to their target currency."*
Plus, same day: *"home screen should be either an overview (balances, movements, …) or 'Pay', not
the list of currencies. The list of currencies should still be easily accessible."*

Supersedes the first-run half of `2026-08-22-trip-ready-delight-plan-IMPLEMENTED-UX-HARDENED.md`
(Journeys 1–3) and amends the Home surface landed by O4 S3 in
`2026-09-04-currency-first-wallet-plan.md`.

## 0. Diagnosis — four defects compose into "looks like scam"

**D1 — the wallet lands the user on an account it knows is empty.** After the chooser,
`reconcileSelectedAsset` selects the home currency's rail (VCHF / ckUSDC). DEMO is exempt from the
Pay fund gate (`PayMode.tsx` requires `!gateDesc.mintable`, and DEMO is `mintable: true`), so the
gate the founder saw was *caused by* the currency choice. The chooser is the last step in the
sequence **and** the thing that produces the solicitation.

**D2 — Home is a list of ten empty accounts.** `HomeTab.tsx` renders every catalogued rail inline
(7 IC + 3 Solana). On a new wallet nine or ten are zero. A screen that is mostly empty money rows
reads as a demand.

**D3 — the one screen that promises practice cannot be performed.** `Rehearsal.tsx` is instructions
only and its first instruction is *"Open dpay on another phone…"*. A solo user is told to do
something they cannot do. That breaks the founder's own 2026-08-29 rule: every step must give an
instruction the user can act on with what is on screen.

**D4 — the trip strip lies, one line deep.** `demoView` (`app/lib/assetBalances.ts`) never returns
`'zero'` — it returns `status: 'ok'` for **any** DEMO amount including `0`. `decideFundsReady`
accepts any `'ok'` with `displayText !== '—'`. So a wallet holding ∂0.00 stamps `fundsReady` and
renders the DEMO row at full colour.

Underneath all four: **the app asks before it gives.** Between launch and the first thing the app
does *for* the user there are three scenes, a name, twenty-four secret words, a mandatory checkbox,
an animation, an unperformable exercise, and a consequential currency decision — and then it asks
for money. That sequence is the shape of a drainer regardless of how honest each sentence is, and
the sentences already are honest.

## 1. Two founder forks — the conservative reading is what gets built

Both are recorded here rather than silently decided.

**F1 — where the 24-word backup sits.** The design as first drafted moved the backup *after* the
practice payment, so the app gives before it asks for a secret. That is the highest-consequence
change in the whole design (its downside is user funds) and the founder did not ask for it.
**BUILD THE FALLBACK: the backup stays where it is**, immediately after create. The sequence still
shortens and still ends in a success. *Founder question: move the backup gate to after the practice
payment? Upside — the words gain a referent, and nothing but valueless DEMO is at stake at that
point. Downside — a longer window before the seed is written down.*

**F2 — what "home screen should be … or 'Pay'" means.** Two readings: (a) the Home screen's
CONTENT should be an overview rather than the currency list, or (b) the app should OPEN on an
overview instead of the scanner — which would supersede the standing `CLAUDE.md` decision that "the
scanner stays the landing screen — the tourist's first gesture is scanning". **BUILD READING (a).**
*Founder question: did you mean the landing screen too?*

## 2. The sequence

Six surfaces. One rule orders them: **nothing consequential is asked of the user until the app has
demonstrated that it works.**

| # | Screen | Fate | Asks for | Exits |
|---|--------|------|----------|-------|
| 1 | **Tour** (`Walkthrough`, 3 scenes) | KEEP unchanged | nothing | `Get started` or skip → 2 (both award `walkthroughDone`) |
| 2 | **Name + Create** | KEEP, trimmed | a display name (optional, defaults `me`) | `btn-create` → 3 · `btn-restore` → restore (skips 3–4) |
| 3 | **Backup** (24 words + checkbox) | KEEP in place (fork F1) | write the words down + tick | `btn-mnemonic-continue` → 4 |
| 4 | **RECOVERY SAVED beat** | KEEP unchanged | nothing (750 ms, auto) | auto → 5 |
| 5 | **Practice** — NEW `Practice.tsx` | **REPLACES `Rehearsal.tsx`** | one tap to review, one to approve | any outcome, or skip → 6 |
| 6 | **Currency chooser** | KEEP, stays last | one currency | continue → Wallet on Home |

The faucet credit fires on create success, so the user reaches Practice already holding ∂100.00 —
the app has given before it asks anything.

**CUT:** `app/components/Rehearsal.tsx`, `rehearsalSteps()` in `app/config/education.ts`, and
`M.education.rehearsal.{title,sheetTitle,steps,stageTags,try}` in all four locales. Its one keeper —
the offline punchline — becomes a permanent footer on Practice. Cutting rather than fixing: Journey
3 asked for "Try with demo funds" and got a leaflet describing a two-phone exercise; Practice
delivers what Journey 3 asked for, so the leaflet has no remaining job. The two-phone guide does not
move to Settings — the walkthrough replay is already the home for "how do I do this with someone
else".

**The restore path skips Practice.** A restored wallet already has funds and already has its words.

## 3. The practice moment — one screen, one real payment, one device

### What is possible, measured

1. **A literal self-payment is not available.** The facade's `pay` refuses `from == to`. The shipped
   app-signed rail does not use that method (`prepareTransfer` → a direct `icrc1_transfer`), and the
   offline fake permits it — so e2e would pass while production behaviour is **unverified**. A first
   run must not rest on an unverified ledger behaviour. Rejected.
2. **Scanning your own screen is physically impossible on one device**, and there is no paste path
   into the payer. Rejected.
3. **Everything needed to pay a *distinct* payee already exists**: `DpayCore.encodeRequest` →
   `wireRequestToIntent` → `prepareTransfer` → `submitTransfer`. Nothing new in core, canister or
   relay.

### The design

The user pays **∂1.00 of practice money to a pinned practice payee** —
`PRACTICE_PAYEE_PUBKEY` in `app/config/constants.ts`, a 32-byte Ed25519 public key generated once
from a secret that is then discarded, documented as keyless. Deterministic, single-sourced,
greppable. The ∂1 is stranded there, which is fine and must be said in the constant's comment: DEMO
is valueless by construction and the faucet re-mints on demand. **Practice must refuse to run on any
currency other than `0`** — that guard is what stops this ever becoming a real burn address.

Rejected alternative: *the app plays the payer and pushes money in.* Money arriving is the better
anti-scam beat, but it removes the Approve gesture, which is the product. The anti-scam job is done
instead by the faucet credit landing before Practice mounts.

### The screen — three states in place

- **A — the request.** Header: the real DEMO balance, polled. Body: a request card in the
  walkthrough's own visual grammar — eyebrow `PRACTICE`, payee `Practice shop`, amount `∂1.00`, one
  line *"This is the code a shop would show you."* Primary: **Review payment**.
- **B — the review.** The **real** payment review, rendered by the same component the Pay tab
  renders (§6). Destination account, amount, fee (DEMO's catalog fee is `null`, so the line reads
  "set by the ledger", never "0"). One honest line: *"Your phone is playing both sides here, so this
  practice needs a connection. On a trip, only the shop needs one."* Primary: **Approve**.
- **C — the outcome, whatever actually happened.** `settled` → the confirmed-success stamp,
  *"That was a real payment on the practice ledger — your phone signed it and the ledger settled
  it."* + the remaining balance; awards `flowUnderstood`. `unknown` → the honest pending state, no
  stamp, no green: *"The payment was signed and sent. dpay has not seen it settle yet, so nothing is
  confirmed. This is exactly what a real pending payment looks like."* `rejected` → the ledger's
  decoded reason + *"Nothing moved."* All three exit through one **Continue setup**. Practice never
  blocks first run.

**Fail-closed branches, each with an action** (founder rule 2026-08-29): no faucet
(`relayCapabilities().demoFaucet === false` — flow 37's world) says the server is not handing out
practice money and offers Continue, **with no deposit address and no add-money CTA**; faucet
cooldown is its own branch carrying the relay's own remaining-time reason; offline explains that
practice needs a connection *because this phone is playing both roles* and offers retry + Continue;
∂0.00 never offers Approve at all.

**Practice awards `flowUnderstood` and nothing else.** It must NOT award `paymentTested` — that
stamp is about a tap-or-scan payment to a real counterparty. Leaving it unfilled is what finally
makes "ONE PAYMENT TO GO" true.

## 4. Anti-scam rules — checkable against a diff

- **R1 — No solicitation before value.** No screen between launch and the wallet may render a
  deposit address, a fundable QR, a fund gate, or an add-money CTA.
- **R2 — Give before you ask.** The wallet is credited before the first screen that asks the user to
  decide anything. If it cannot be credited, the app says so and asks for nothing.
- **R3 — Play money is labelled wherever it appears**, in whole translatable sentences, never by
  glyph alone.
- **R4 — No screen claims a state it has not verified.** No `fundsReady` on an empty wallet; no
  "Paid" before the ledger confirms; `unknown` never renders as success.
- **R5 — Every first-run button is completable alone, on this device, right now.** This is the rule
  `Rehearsal.tsx` breaks and the reason it is cut.
- **R6 — A zero balance is a fact, not a prompt.** Zero rows render dimmed as accounts the wallet
  *can* hold; the fund panel appears only after the user chooses an action that needs funds.
- **R7 — "Here is your money" and "give us money" are distinguished structurally, not by tone.** Any
  ask-for-funds surface must be reachable only from a user-initiated gesture, name who is asking and
  why, and state what happens next. An unprompted panel fails by construction.

## 5. The trip strip — keep it, fix the lie

Cutting the strip would be the wrong lesson from a one-line bug. `demoView` must return `'zero'` at
a zero amount and `'loading'` at an unknown one, exactly like `icAssetView`. `decideFundsReady` then
needs no change. The exemption's stated rationale — dimming would mislead because DEMO is
top-up-able — is backwards: the top-up affordance is the button on the same row; dimming a zero
balance is simply the truth. This fixes the false `fundsReady` **and** the ∂0.00 row rendering at
full colour.

**Walk all four consumers, do not assume:** the header eyebrow's offline `~approx` branch (the
honesty rule flow 100 already had to fix once), the Home account row's `zero=` prop,
`decideFundsReady`, and `PayMode`'s shown-balance path.

After the fix, first run ends at **3 of 4** — `recoverySaved` ✓, `flowUnderstood` ✓, `fundsReady` ✓,
`paymentTested` ✗ — and the payment it points at is a real tap-or-scan payment.

## 6. Home is an overview; the currency list is one gesture away

Home keeps: headline, a NEW accounts affordance (`btn-home-accounts`, labelled with the account
count, in the headline block), the action row, and **Activity raised from 3 rows to 5** — it is now
the body of the screen, not a footer. The ACCOUNTS section leaves Home.

The list moves to a **route**, not a restored modal: `app/components/AccountsTab.tsx`, reached by
adding `'accounts'` to Wallet's `mode` union. The precedent is `'convert'`, already a non-tab route
with a back handler. **This partly reverses O4 S3**, which inlined the retired `BalancesSheet` onto
Home — stated plainly so it does not look accidental. A route participates in the back handler, is
`?screen=`-addressable, and has no overlay or focus trap; `BalancesSheet.tsx` stays deleted.

Every row testID stays byte-stable (`asset-<key>`, `-select`, `-main`, `-rail`, `btn-topup`,
`btn-toggle-testnet`, the liquidity note). **One rename:** the container `home-accounts` →
`accounts-list`, because the old name would be a lie.

**Four entries, the first of which satisfies "from the main screen" literally** — it is on the
header, which renders on every tab including the Pay scanner:

| Entry | Today | Change |
|-------|-------|--------|
| header balance chip (`balance`) | → `mode = 'home'` | → `'accounts'` |
| hotkey `a` | → `'home'` | → `'accounts'` (restores its original Balances meaning) |
| `btn-home-accounts` on Home | — | new |
| passport `fundsReady` step | → `'home'` | → `'accounts'` |

`CLAUDE.md`'s asset-first rule stays satisfied: every enabled asset including zero-balance rows is
visible, one gesture from every screen, never behind a positive-balance condition.

**The payoff:** the last screen of first run is a headline, four actions, and the user's own
practice payment in Activity — a receipt, not a request.

## 7. The code change

**One first-run router replacing two half-routers.** Today the sequence is split between an
in-memory `beat` machine in `Onboarding.tsx` and a persisted gate in `Wallet.tsx`. That split is why
an app killed between the identity being persisted and `finishCreate` **skips the backup screen
forever today**. `app/App.tsx` becomes the single router over persisted facts (it already batches a
mount read of relay/theme/locale/home-currency; add `loadJourney()`):

```
identity === null                       → Onboarding      (tour + create + backup)
!hasSeen(journey, 'firstRunPractice')   → Practice
otherwise                               → Wallet          (still gates on homeCurrency → chooser)
```

**New journey state: exactly one `seen` marker, no schema change.** The stamp key set is documented
as closed; the free-form `seen` dimension (`hasSeen`/`markSeen`) is the right home for "this
one-time surface is done". Use `'firstRunPractice'`, marked on completion **and** on skip.

**New files:** `Practice.tsx` (~40 lines of logic over existing services); `PaymentReview.tsx` —
PayMode's review card extracted so Practice and Pay render the *same* review, testIDs byte-stable
(this is the DRY answer to "the practice review must be the real review"); `AccountsTab.tsx`.

**Changed:** `App.tsx` (the router); `Onboarding.tsx` (delete the `beat` machine and the `Rehearsal`
import; the faucet call fires on create success; restore marks `firstRunPractice` seen);
`HomeTab.tsx` (remove the accounts section, add the affordance, activity 3→5); `Wallet.tsx` (mode
union, the four retargets, render `AccountsTab`); `assetBalances.ts` (the `demoView` fix);
`constants.ts` (`PRACTICE_PAYEE_PUBKEY`, `PRACTICE_AMOUNT_RAW`); `education.ts` (delete the
rehearsal types + builder); i18n wallet/settings in four locales.

**Deleted:** `Rehearsal.tsx`, `app/__tests__/Rehearsal.test.tsx`, `e2e/tests/90-rehearsal.mjs`.

**Copy rule for `M.education.practice`:** follow the catalog's existing convention — interpolation
is a typed function, never a spliced verb; the canonical model is `fundBody`, which branches into
two whole sentences rather than injecting a verb into one. Every Practice state gets its own
complete sentence per branch.

**E2E harness:** `e2e/harness/lib.mjs` owns the sequence. `onboardWallet` reorders and
`skipRehearsalIfPresent` becomes `skipPracticeIfPresent`; `openBalances` retargets from `tab-home`
to the header `balance` chip, so its ~56 callers are unchanged. The ~106 flows that go through
`onboardWallet` are insulated; the 29 that tap raw onboarding testIDs need the reorder applied
individually.

## 8. E2E flows

| # | Name | Journey | Verifies | Covers |
|---|------|---------|----------|--------|
| 145 | practice-payment | onboard | The first-run practice settles a REAL ∂1.00 DEMO transfer to the pinned practice payee: the request card names payee and amount, Approve signs one envelope, the ledger confirms, the balance drops to ∂99.00, `flowUnderstood` persists and `paymentTested` does NOT. | practice, first-run, demo, real-settlement, flow-understood, journey-stamps |
| 146 | practice-not-settled | onboard | A practice payment that does not settle never claims success: an unknown outcome renders the pending state with no stamp and no success colour, a ledger refusal renders the decoded reason, and both leave Continue enabled. | practice, pending-honesty, no-false-success, error-path |
| 147 | first-run-no-solicitation | onboard | From cold launch to the wallet, no first-run screen renders a deposit address, a fund gate, or an add-money CTA. | first-run, no-funding-solicitation, anti-scam, structural |
| 148 | first-run-backup-resume | onboard | The backup gate survives an app kill: a wallet created and reloaded before the words are acknowledged still lands on the backup gate and cannot reach the wallet until `recoverySaved` persists. | backup-gate, persistence, recovery, first-run-router |
| 149 | restore-skips-practice | onboard | A restored wallet skips practice, landing on the currency chooser with `firstRunPractice` seen. | restore, first-run-router, journey-stamps |
| 150 | accounts-route | system | The currency list is one gesture from every screen: the header balance chip on the Pay scanner opens the Accounts route, every enabled asset including zero-balance rows renders, back returns to the previous surface, and no modal overlay is mounted. | accounts-route, balances, one-gesture, zero-balance-visible |

**Existing flows:** 90 rehearsal **DIES** (its subject is deleted; its `recoverySaved`/backup-
mandatory and first-run-landing assertions move to 145/148). 37 onboard-no-faucet **becomes
load-bearing** — its `no-funding-solicitation` slug becomes the assertion of record for the
no-faucet Practice branch. 94 trip-passport gains the **D4 regression pin**: a wallet holding ∂0.00
must render `trip-strip-dot-fundsReady` UNFILLED. 121/130 retarget to the Accounts route. 133
asserts Home has no `accounts-list` and does have `btn-home-accounts`. 135 cap 3→5. 136 renamed
`accounts-page`. 01/23/58/68/82/88/118/120/129/131 are mechanical reorders. 40/84 visual baselines
reseed (home light+dark, new accounts, new practice).

## 9. Risks

1. **The practice strands ∂1 at a keyless address** — harmless while DEMO is valueless, a defect the
   day it is not. Guarded by the currency-0 refusal and a jest pin.
2. **Practice requires connectivity in an offline-first product.** Unavoidable (one device, both
   roles) and turned into the lesson, but a user practising on a plane meets the offline branch
   first.
3. **The whole design depends on the faucet capability fix landing.** If `/api/v1/capabilities`
   still reports `demo_faucet: false`, every first run takes the no-faucet branch. Verify live
   before shipping.
4. **`demoView` returning `'zero'` touches four consumers**, one of which is the offline `~approx`
   honesty rule flow 100 already had to fix once. Walk all four.
5. **Moving the currency list reduces discoverability of zero-balance assets.** One gesture is not
   zero gestures; flow 150 pins the reach but cannot pin whether people notice it.
6. **Baseline churn** — reordered onboarding plus a restructured Home reseeds light and dark visual
   baselines. Design-approval territory, not a mechanical accept.

**Least sure:** whether a first-time user reads a real ∂1.00 payment to a keyless "Practice shop" as
*genuinely succeeding at a payment* or as the app going through the motions with itself. Every
mechanical claim above is grounded in a file; that one is a judgement call with no user evidence.
Cheapest way to settle it: build states A–C against the offline harness and put the three
screenshots in front of the founder before any i18n, harness or flow work starts.

## Status

NOT STARTED. Build order: §5 `demoView` fix (S) → §3 Practice (M) → §6 Home/Accounts (M).
