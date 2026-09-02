# dpay as the merchant side of OpenCryptoPay — the next milestone

Founder decision, 2026-09-02: **this is the next milestone.** Written up here, not started. The
payer-side integration is done and is a separate thing (measured behaviour:
[`2026-09-01-opencryptopay-findings.md`](2026-09-01-opencryptopay-findings.md)).

## The idea, in one paragraph

Today dpay can PAY an OpenCryptoPay till. This milestone makes dpay BE one. A shop installs dpay,
shows a code, and gets paid — and because OpenCryptoPay is an open standard with real wallet
adoption (Cake Wallet, Phoenix, Wallet of Satoshi, Binance, per `opencryptopay.io`), the people
paying that code do not need dpay. dpay users additionally get NFC, which the standard itself lists
as "in development". So the merchant side is where dpay's existing NFC work stops being a curiosity
and becomes the reason to choose it.

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

Not estimated in effort here — this is the shape, to be turned into units next session.

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

## Open questions to settle before building

- Which assets a merchant may accept, and whether a merchant may accept several at once (the
  standard's menu shape says yes).
- Whether dpay's provider endpoint is hosted (the relay) or on-device. Hosted is simpler and the
  relay already exists; on-device is more honest about "no intermediary" and needs the merchant
  phone reachable, which a shop's wifi does not guarantee.
- EURC's status as a dpay asset (VCHF's EU twin) — not yet in the catalog.
- Whether to publish the endpoint for other OCP wallets immediately, or run dpay↔dpay first.

## Related work landed 2026-09-02

The payer-side gap this session's Spar walkthrough exposed is FIXED and is not part of this
milestone: a till quotes a MENU, and dpay used to check only the payer's pre-selected asset and send
them to Balances on a miss. It now offers the till's own menu on the spot
(`app/components/OcpAssetChoice.tsx`, shared by both rails). That matters here because the merchant
side must serve exactly such a menu.
