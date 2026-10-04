# Convert UX rework: don't make the user think (founder 2026-10-04)

Founder directive, verbatim intent: "Please adversarially review the swap process ignoring the
requirements docs and make it intuitive. This is the highest priority requirement. Rework the UI
fully... Just make it intuitive for a new user. As a new user, don't make me think!"

## 1. Adversarial findings (every defect class observed live, 2026-10-02 -> 10-04)

The user's mental model is: "I have A. I want B. It costs a bit. It takes a minute. Tell me when
it's done." Everything below is a place the app made them translate instead.

F1 JARGON LEAKS. User-facing lines named canister pool ids (65mrh-fqaaa-...), venue names
   (ICPSwap, SideShift, Circle CCTP), rails, and verbs like "approve the pool", "pending
   withdrawal", "awaiting deposit", "quote expired", "provider refunded". A new user can map none
   of these. Support evidence showed the WRONG leg's id (bug 1 finding 4).
F2 EXPERT ROUTE CHOICE. The sheet exposes "Other venues" and asks the user to pick a row like
   "ICPSwap -> Circle CCTP". Fee/speed/liquidity tradeoffs are an expert decision presented raw.
   The auto-pick exists but the UI makes the manual list look like homework.
F3 LIES UNDER STATE CHANGES. Step header said "Step 2 of 3" while the body showed leg 3; a spent
   leg-1 instruction stayed under the pending panel; two conflicting expiry clocks on one screen
   (7:12 vs 7:02); minOut of the first pool leg rendered with the FINAL asset's decimals+symbol
   ("360.179063 EURC" for 3.60179063 ICP); "dpay keeps watching the ledgers" next to "expired -
   nothing can move anymore". Root: many scattered panels each partially keyed on record state.
F4 CONFIRM GRAMMAR INCONSISTENT. CoW looped "Rate moved - Confirm again" 11 times on +-0.04% fee
   jitter (fixed 767c0951 order-is-the-lock); cefi still re-confirms on any amount delta; create-
   kind setup signs on press 1, fund kinds confirm. One rule must hold everywhere.
F5 EXPIRY/REFUSAL DEAD ENDS. Floating venue minimums and expired orders strand users on dense
   paragraphs; honest-refuse panels list route mechanics instead of one plain reason + one action.
F6 TERMINAL STATES DENSE. stuck/unknown/expired screens are paragraphs. A terminal state needs:
   status word + one sentence + one action, receipts behind "Details".
F7 SILENT REFUNDS. Venue refunds (deposit minus fee) land later with no user line; the stuck-
   evidence screen exists but nothing tells the user "your 2.671 ICP was refunded to your wallet".

## 2. Redesign: the four screens

ONE canonical progress surface replaces the scattered panels (ConvertIntentSheet inline states,
ConvertStatePanel, ConvertRouteStatePanel, ConvertCrossRailStatePanel, SolStatePanel story bits).
Money logic (prepare/execute/resume, records) is UNTOUCHED; this is presentation + copy.

S1 OFFER (amount entry): amount in, then ONE recommendation line: "You get about 10.63 EURC.
   Arrives in a few minutes. Fee about 0.09." Below it one quiet line "2 exchanges involved" when
   composed. Venue/route details live ONLY behind a collapsed "Options" disclosure that also
   carries alternatives (pre-selected best, plain one-line reasons: "cheapest" / "fastest").
S2 CONFIRM: one button "Convert 6.68 VCHF". The quoted total is the lock (order-is-the-lock
   everywhere): no re-confirm for noise; ONE silent re-quote if the price moved <5%; re-confirm
   with "Price changed: now about X" ONLY on a material move. Exactly one expiry per screen.
S3 PROGRESS: a 3-line plain story, never "Step n of m": "Converting... 1. Your ICP swap is done.
   2. Now exchanging for EURC. A few minutes left." Each line stateful (done/active/pending).
   One expiry, the ACTIVE step's. The support line appears only while pending and quotes only the
   active step's own reference. No ids, no venue names in these lines. "Details" disclosure holds
   addresses/ids/fees for the audit trail.
S4 DONE / FAILED: done = "Done. 10.63 EURC is in your wallet." (+ Details). Failed = status word
   + one sentence + one action ("Your 2.671 ICP was refunded - it never left your wallet." /
   "Nothing was sent. Try again when ready."). Expired = the same grammar. No paragraphs.

## 3. Copy law (all locales, en plain / de du / es tu / fr vous, no em-dashes)

- No canister ids, mints, addresses, rail names, or venue brand names in any primary line.
  Venue names allowed ONLY inside the collapsed Options/Details disclosures.
- Verbs: "converting", "exchanging", "sending". Never "approve", "withdraw", "burn", "attest".
- Amounts always with their own asset's symbol and the leg's own decimals (bug 3 fix generalizes).
- One fact per line; one expiry per screen; support reference = the active step's reference only.
- Refusals: "Not enough X" / "The exchange minimum is Y X right now" / "No exchange available for
  this pair yet." + the one action that fixes it.

## 4. Implementation plan (lane; presentation layer only)

1. ONE ConvertProgressView driven by the record's live state (mirrors executor probe target,
   reuses pendingPayoutViewOf/activeLegExpiryMs/legRowMood from 28965286 and the leg-scoped
   minOut from 32be15d3). Sheet states delegate to it; dead panels deleted, not duplicated.
2. Copy sweep across app/i18n/domains/{en,de,es,fr}/convert.ts per the copy law; support line
   per-leg; refund-surfaced line using the stuck probe's refund evidence.
3. Confirm lock: order-is-the-lock for cefi like CoW (767c0951 pattern): sign the displayed
   quote while valid; ONE silent re-quote within tolerance; re-confirm only on material change.
   Floating venue minimum: keep the pre-sign fresh-verify (atafix2 semantics) but re-confirm copy
   says what changed in one line.
4. Refusal/terminal rewrites per S4; stuck evidence stays reachable under Details.
5. Pins: flows 184/186/188/190/195/196/200/209/227/228 stay green (behavior unchanged); NEW pins
   assert the copy law (regex: no /[0-9a-z]{5}-[0-9a-z]{5}/ canister-id shapes, no venue brands,
   no "approve|withdraw|burn|attest" in primary lines); new flow pin for silent single re-quote.
6. Gates: typecheck + smoke + touched suites per iteration; ONE full flow+test-app chain at end
   via testruns (NO timeoutSeconds); rows dirty=no at head. Leave unmerged for the orchestrator;
   orchestrator drives the emulator against the founder's bug-3 scenario states for the final
   brutal pass.
