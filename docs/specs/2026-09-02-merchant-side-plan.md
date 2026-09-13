# dpay as the merchant side of OpenCryptoPay — the next milestone

Founder decision, 2026-09-02: **this is the next milestone.** This file is the design and the
decisions; what is built, what is not, and what is deployed live in `OPEN_ISSUES.md`. The payer-side
integration is a separate thing (measured provider behaviour:
[`2026-09-01-opencryptopay-findings.md`](2026-09-01-opencryptopay-findings.md)).

## The idea, in one paragraph

Today dpay can PAY an OpenCryptoPay till. This milestone makes dpay BE one: a shop installs dpay,
shows a code, and gets paid at its own account.

**Who can pay that code — corrected 2026-09-04, and this correction is load-bearing.** The plan was
written on the premise that a Cake, Phoenix or Binance user could pay a dpay till, so serving the
standard would bring merchants payers they would not otherwise have. **That premise is false for
v1's asset.** Measured twice against the provider's own compatibility list: no wallet on it can pay
an Internet Computer asset at all ("The standard's reach" in
[`2026-09-01-opencryptopay-findings.md`](2026-09-01-opencryptopay-findings.md)), and v1 accepts VCHF
only. So v1 serves **dpay payers paying dpay tills**, and standard conformance is future-proofing —
the cost of being reachable the day an IC-capable wallet exists — not distribution.

That is not a retreat, because dpay↔dpay is where dpay can be better than every wallet on that list.
dpay's own wire already lets the **payer be offline** over NFC or QR; OpenCryptoPay cannot, by
construction — three HTTP calls from the payer's wallet against a 300-second quote — and the standard
itself lists NFC terminals as "in development". Be exact about the tense: **paying a dpay till
through these routes keeps the payer online today.** Making the till take an offline tap is the NFC
item below, and it is where dpay's existing NFC work stops being a curiosity — against dpay's own
payers, not against a wallet ecosystem that cannot reach this rail at all.

**Do not put third-party wallet reach in a deck, a demo script or an investor email.** It is not
true today, and it is exactly the kind of claim `CLAUDE.md`'s external-claims rule exists to stop.

## Why this and not the alternatives

Three merchant-side routes were considered on 2026-09-02:

1. **dpay as a nicer terminal on top of DFX.** Rejected as the milestone. The merchant becomes DFX's
   customer, not dpay's: onboarding is referral-gated, KYC is required above CHF 1,000/month, and a
   bank account is needed for the fiat payout. dpay would add polish and own nothing.
2. **dpay hosts the merchant side itself.** CHOSEN. The standard is permissionless, so no licence,
   no bank, no KYC, no signup — the shop is paid directly at its own account. This is the
   no-custody non-negotiable turned into the selling point instead of a constraint.
3. **Tap dpay on existing card/TWINT terminals.** REJECTED, and not as a stretch goal —
   as infeasible. A card terminal speaks EMV, so being tapped by one means being a card issuer:
   BIN sponsorship, EMV certification, and settlement through the card networks, which reintroduces
   the exact FX and interchange tolls `positioning.md` says dpay escapes. It also requires somebody
   to guarantee fiat to the merchant, which is custody. Android independently blocks it (payment
   AIDs are reserved for the device's default payment app), and TWINT is a closed bank-owned scheme
   that cannot be emulated. The only shipping version of this idea is a third-party-issued "crypto
   card", which is a swap and someone else's product. Do not revisit without new facts.

## The insight that makes route 2 work

Merchants historically demand fiat for ONE reason: price risk. A franc-denominated token removes
it. A Swiss shop paid in **VCHF** holds a CHF-stable balance with no bank, no KYC and no licence —
and VCHF is already a complete first-class asset in dpay (catalog id 7, ledger
`ly36x-wiaaa-aaaai-aqj7q-cai`). EURC is the EU equivalent to verify.

They will still need a bank eventually, to pay suppliers and wages. That is a **later** problem and
explicitly not an onboarding one; when it arrives it is a licensed third party the merchant
authorizes directly, exactly as `positioning.md` already provides for. dpay never converts.

## What it actually takes

The shape, in design voice throughout — no bullet below is a claim about what exists.

- **Serve the standard.** Implement the merchant half of OpenCryptoPay in the relay: a payment-link
  endpoint that answers the step-2 details read (menu + live quote + expiry), the step-3 callback
  (destination URI per chosen asset), and the step-4 `/tx` submission. The payer-side client
  (`app/services/opencryptopay.ts`) is the exact contract to serve, and
  `e2e/harness/ocp.mjs` is already a working model of the state machine.
- **Pricing.** A till charges in CHF/EUR and must quote crypto amounts. dpay does not quote or
  convert (non-negotiable), so this needs a deliberate answer: for VCHF/EURC the quote is 1:1 and
  no price source is needed at all, which is another reason to lead with them. Anything else needs
  an explicitly-labelled third-party price feed, and that decision is NOT made here.
- **Verification, not trust.** The merchant side must confirm the payer's transfer on-chain before
  it says "paid" — the same discipline the payer side already applies in reverse. Reuse the
  ledger-history reconciliation the IC rail already has.
- **The one-shot asymmetry, from the other end.** dpay's payer side is built around the fact that a
  provider grants exactly one submission. As the provider, dpay decides that rule. It should be
  strictly kinder than DFX's: an idempotent submission that can be retried is a strictly better
  standard-compliant behaviour and directly removes the loss path documented in the findings doc.
- **NFC.** The differentiator. The merchant terminal arms the reader; a dpay payer taps. The IC
  rail's HCE hop is already proven on two physical phones.
- **Onboarding = none.** Install, pick the asset, show your own account. Anything more is a
  regression against the whole point.

## Decisions taken 2026-09-03 (founder), and the contract they imply

- **v1 accepts VCHF only, priced 1:1 with CHF.** The merchant enters CHF 10 and the customer's
  account goes down by exactly CHF 10. No price feed, no oracle, no rate for dpay to stand behind,
  and no rounding argument at a checkout — the whole pricing problem is deleted rather than solved.
  EURC gives the EU the same deal when it lands. Other assets stay out of v1 precisely because they
  would require quoting a rate.
  - **AMENDED 2026-09-12 (founder): the SHOP pays the ledger fee, not the customer.** "The payer
    pays exactly `10.00000000` VCHF" was 1:1 on the transfer and NOT on the customer's statement: an
    ICRC ledger debits the sender the fee on top of the amount, so a CHF 10 charge was taking CHF
    10.0001 out of the customer's account. A price is a price, as at every card terminal — so the
    till now quotes the price MINUS the fee (`9.9999`), the ledger adds the fee back onto the
    sender, and the customer is debited exactly CHF 10 while the shop receives CHF 9.9999. The
    mechanism, and why subtraction is the only lever ICRC-2 offers, is `LEDGER_FEE_RAW` in
    `crates/dpay-relay/src/till.rs`; proven end to end on both channels by e2e flows 114 (scan) and
    117 (tap). **Extended 2026-09-14 (`b68ebe8`): every OTHER payee-quoted amount in dpay now
    carries the netted wire too** — the Receive-tab request link `amount=` and the NFC 132-byte
    wire (`nettedWireRaw`, `app/lib/amount.ts`: live `icrc1_fee` → catalog fallback → verbatim
    when the fee is unknown; refused when the fee covers the price), and the SOL native
    `solreq:v2`/derived pay link (`netSolWireLamports`, `app/solana/spl.ts`). The payee screens
    headline the typed price with a fee/receives line; the payer's total debit is exactly the
    price. Documented exceptions: SPL-token requests stay verbatim (a token transfer charges no
    fee in the token itself — nothing to net), and OpenCryptoPay providers still quote gross —
    their wire is outside dpay's control.
- **The provider endpoint is HOSTED ON THE RELAY**, not on the merchant's device. The payer's wallet
  must be able to *reach* the provider over https, and a shop phone behind NAT with no certificate
  cannot be reached — that is the whole reason, and it survives the corrected premise above intact
  (a dpay payer has to reach it too). The relay never touches funds: it publishes a price and a
  destination the MERCHANT owns, and verifies arrival. No custody, no new counterparty.
- **The merchant creates a charge in the dpay app first**, with a relay-served web page later. Both
  drive the same endpoints, so the second is additive.

## Decisions taken 2026-09-04, closing the questions this file used to leave open

- **Run dpay↔dpay. Serve the standard anyway.** Forced by the measurement in the opening section,
  not chosen: there is no third-party wallet to publish to. Conformance stays because it costs
  nothing once written and is the only thing that makes a future IC-capable wallet work on day one.
  Nothing about the endpoint is secret — it is simply not a distribution channel.
- **One asset, VCHF, and no multi-asset menu in v1.** The standard's menu shape permits several
  assets at once; v1 serves exactly one entry, because every additional asset needs a rate somebody
  has to stand behind — the exact thing the 1:1 decision deletes.
- **Only someone who can sign for the paid account may ring up a charge.** The ring-up names the
  ed25519 key whose account every payer is then told to pay; unsigned, that is a stranger's charge
  on dpay's own domain. The core carries the whole acceptance rule — `validate_till_open`,
  `dpay-till-open-v1` (`-v2` when the ring-up carries a note — the payer-read purpose,
  signed like the name; added 2026-09-13), bytes pinned by `dfx/till_open_signing.json` — so the relay checks rather
  than re-derives it. The routes are separately gated off by default, and why they are:
  `crates/dpay-relay/src/app.rs`, at the till gate. Status of both: `OPEN_ISSUES.md`.
- **The own-relay trust rule is GONE, and nothing replaced it.** It existed to carve dpay's own till
  out of a blanket refusal of non-ICP Internet Computer assets, and that refusal was built on a
  wrong diagnosis of the 2026-09-03 loss — the real cause was the spelling of the reported
  transaction id, measured and fixed on 2026-09-04 (`docs/specs/2026-09-01-opencryptopay-findings.md`).
  With the refusal removed the exception had nothing to except, so `isOwnRelayProvider` and its
  plumbing were deleted rather than left as an inert privilege. The open question it carried — what a
  dpay payer should do at a SECOND dpay merchant's relay — is answered by there being no distinction:
  every provider is treated alike, and none is trusted for anything beyond what the payer approves on
  an explicit review.

## Verification: scan the merchant's own history, never trust a reported index

The one design point worth stating loudly, because the payment lost on 2026-09-03 is the argument
for it.

DFX verifies by taking the transaction identifier the payer reports and looking it up. Which LEDGER
it looks it up on is decided by the SHAPE of that string, and that rule is documented nowhere — dpay
reported a bare block index for a VCHF payment, the provider dutifully searched the native ICP
ledger, and a correct payment was refused with the money already gone (the rule, and the measurement
that established it: `docs/specs/2026-09-01-opencryptopay-findings.md`). **dpay's provider must not
accept a reported identifier as the source of truth at all** — then there is no format for a payer
to get wrong, and no undocumented rule for dpay to have to publish. It already has the
right primitive: `transactions_on_ledger` (`crates/dpay-relay/src/ledger/api.rs`), the same
exact-memo merchant reconciliation the Receive tab uses (flows 97/98). Verification must therefore
be: read the MERCHANT's own incoming transfers on the charge's ledger, and look for one that matches
the charge's amount, arriving at or after the charge was rung up, **and not already consumed by
another charge**.

That last clause is a rule in its own right, not a detail of the other two — amount and arrival time
cannot tell two same-price charges apart, so the matcher must own the consumption. Its mechanism and
the second half of the same rule (a new ring-up voids the merchant's previous charge) are stated
where they are enforced: the module header of `crates/dpay-relay/src/till.rs`.

Three properties follow from that rule, and each is something DFX's design cannot offer:

- **Wrong-ledger lookups are impossible** — the ledger is the charge's own, chosen by us, never
  inferred from a payer-supplied string.
- **The submission is IDEMPOTENT.** Re-reporting a payment re-reads history and reaches the same
  answer, so a retry is safe and a timeout is not fatal. DFX's one-shot burns both the quote and the
  transaction id on any failure, which is the loss path the payer side is built around; as the
  provider, dpay simply does not have to inflict it.
- **A payer that reports nothing still gets credited**, because arrival is observed rather than
  announced. The reported `tx` is a hint that lets us answer immediately instead of on the next poll.

## Still open

- EURC's status as a dpay asset (VCHF's EU twin) — not yet in the catalog, and the only thing that
  would give the EU the same no-price-feed deal.

## Related work landed 2026-09-02

The payer-side gap this session's Spar walkthrough exposed is FIXED and is not part of this
milestone: a till quotes a MENU, and dpay used to check only the payer's pre-selected asset and send
them to Balances on a miss. It now offers the till's own menu on the spot
(`app/components/OcpAssetChoice.tsx`, shared by both rails). That matters here because the merchant
side must serve exactly such a menu.
