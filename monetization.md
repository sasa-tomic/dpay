# Monetization — direction (decided shape; numbers TBD)

This is the direction we intend to take on fees. Not in the PoC.

## The line

**We monetize the payment rail we built. We never monetize movement of funds we don't control.**

That sentence is the whole strategy. It is coherent to a regulator (we charge for software and a rail, not for transmitting value), coherent to an investor (a real take rate on a real product), and it is why the swap is free.

Corollaries, all hard:

- **No cut on swaps. Ever.** Not a fee, not a spread, not client-side, not server-side. See the non-custodial non-negotiable in `CLAUDE.md`.
- **The payer never pays.** Ever. Not in P2P, not at a merchant.
- **Taking payments is free.** The recipient pays only when they opt into add-ons — whoever they are, whatever their size.

## Free by default — private or business (set 2026-08-26)

**Superseded twice:** first the "~$200/month received free, then 0.5%" volume allowance; then the P2P-vs-merchant *mode* tier, which charged merchant mode 0.5% from dollar one. Both are replaced by the following.

**Accepting payments is free for everyone, individuals and businesses alike.** There is no mode to be in, no volume threshold, and no size test. A business pays only when it wants add-ons a one-person shop does not need.

| | **Default (free)** | **Add-ons (~0.5% of received volume)** |
|---|---|---|
| Price | **Free forever** | ~0.5%, opt-in |
| Name at approval | claimed name, shown to payer | — |
| Standing | — | business badge backed by payment history |
| Devices | one | many (staff terminals) |
| Refunds | send money back manually | first-class, keyed to the original payment |
| Reporting | transaction list | statements, per-staff breakdown, export |

There is no allowance to game, because there is no allowance — and no size to police, because size is not the test. The add-ons carry the anti-sybil property themselves (below), so splitting into five accounts is self-defeating rather than something we have to detect.

Free is not charity, it's the growth engine. Charging someone to receive money is bad product and a worse story, and the market stall, the coffee cart and the friend who sells jam were never going to pay us anyway. They upgrade the day they want standing customers recognise, a second cashier, and a report for their accountant. Self-selecting, honest, and exactly how Square and Stripe convert.

## The add-ons — chosen by one test

The test is **not** "what's valuable." It's:

> **Does this feature lose its value if the merchant splits into five accounts?**

That property is what *replaces* sybil resistance. We are not defending a free tier; we are making the attack self-defeating. Only features that pass belong behind the fee.

### The name at approval is free. The badge is not the name.

Two different things, and the split is load-bearing:

- **Free, for everyone:** the payer's screen reads **"Pay $12.40 to Blue Bottle Coffee"** rather than a principal hash, *before* they approve. This is the answer to QR-swap fraud (someone stickers a fake QR over yours — endemic on Alipay/WeChat/UPI) and it must never be paywalled. A swapped QR points at an account whose name the payer doesn't recognise; charging for that would be selling safety.
- **Paid:** the **business badge**, which displays standing the account has actually accrued — *"receiving since March 2026"*, payment history, age. That is what converts customers, and it is anti-sybil by construction, because splitting resets it to zero.

**Hard constraint: neither may ever become KYC, and the badge must never be called "verified."** No document check, no vouching, no attestation of legal identity. "Verified" tells the payer we checked something — and then we either run KYB, buying the cost, the process, and the identity infrastructure this architecture exists to avoid, or the badge means "paid us" while claiming otherwise, which is a lie to the person about to hand over money. The badge asserts history on dpay and nothing more. The UI may say *"receiving since March 2026."* It must never say *"dpay verifies this is a real business."*

### Multi-device / staff terminals

One merchant account, several cashier phones. Splitting doesn't merely fail to help — it makes the merchant's life *worse*, because every cashier becomes a separate business.

### Refunds, keyed to the original payment

References the original nonce; partial refunds supported; the customer sees **"Refunded ✓"** rather than a mystery payment from a stranger. Splitting → *which of my five accounts took that payment?*

Note we **structurally cannot offer chargebacks** — that requires reversal power over user funds, which we do not and will not have. Refunds are our entire answer to the dispute question, so they have to be excellent. This is a real competitive gap against cards and we should be ready to answer it, not surprised by it.

### Consolidated settlement reports

Daily/monthly statements, per-staff breakdown, tax export. Splitting → five disjoint reports merged by hand at midnight.

### What these have in common

They are all the same thing: **the account is a durable, single, accountable entity.**

That is *why* they're anti-sybil, and it means we are not selling a feature checklist — we're selling **being a business on dpay**. A business wants one identity by definition. Pitch it that way.

### Tier 2 — valuable, but sybil-neutral

Build later; **do not price on them**, because splitting doesn't hurt them:

- **Static counter QR** ("the sign at the till"). Note the payer enters the amount, so consent gets *stronger*, not weaker — the payer's signature still binds amount+payee, with a payer-generated nonce. This is the dominant small-merchant form factor on UPI/Alipay.
- Webhooks / POS integration
- Tips
- Invoices / recurring

## How the fee is collected — no protocol change

The payer signs exactly what they sign today: `{from, to, amount, nonce, expiry}`.

The canister credits the merchant `amount - fee` and dpay `fee`, per a **public fee schedule held in canister state**. That's it. It's an ordinary ledger fee, the same shape every ICRC ledger already has.

- The **payer is indifferent to the split** — they authorized `amount` leaving their account, to that payee, for that request. Where the credit lands afterward is not their consent question.
- The **merchant is online** and consents by enabling add-ons.
- **Do not add a `fee` field to `Authorization`.** It would bind a value the offline payer cannot know, and would wreck the offline path for zero gain in consent.
- The offline path is **completely untouched**. This is the main reason to prefer this design.

## Consequence: the canister controller is load-bearing

If the fee is computed by the canister rather than signed by the user, then **whoever can upgrade the canister can set `fee = 100%`.** The revenue model and the "we can't touch your funds" claim are therefore *the same question*.

- **Blackhole the controller, or put it under SNS/NNS governance.** Otherwise "we can't touch your funds" is a promise, not a property.
- **The fee schedule must be a governed *parameter*, not a hardcoded constant.** Otherwise blackholing the controller freezes our pricing forever, and any re-pricing becomes a code upgrade — i.e. a trust event. Cheap to get right now; expensive later.

## Pricing sanity

| Rail | Take |
|---|---|
| Card interchange | 1.5–3% |
| Stripe | 2.9% + 30¢ |
| Alipay / WeChat | ~0.6% |
| Remittance | 5–7% |
| **dpay** | **~0.5%, opt-in** |

Marginal COGS is a canister call. Gross margin on the add-ons is close to absurd.

**Read this table carefully before quoting it.** Every other row is a take rate on *all* volume on that rail. Ours is not: since accepting payments is free by default, 0.5% is an **attach rate on the subset of merchants who buy add-ons**. Anyone modelling GMV × 0.5% gets a number we do not mean. Know the expected attach share before putting the 0.5% next to interchange in a deck or an email — an investor will do that arithmetic unprompted.

## Open

**Keep the relay bypassable and self-hostable** — a merchant must always be able to submit straight to ICP; the relay is a convenience, never a chokepoint. MiCA's *"transfer services for crypto-assets on behalf of clients"* is an activity test independent of custody, and it bites a mandatory chokepoint far harder than an optional one. Costs ~nothing architecturally. Settle before the pilot.

## Not in scope

None of this is in the PoC. The PoC proves offline pay. Fees, badges, terminals, refunds, and reports all come after.
