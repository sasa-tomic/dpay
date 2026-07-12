# Monetization — direction (decided shape; numbers TBD)

Referenced from `CLAUDE.md`. This is the direction we intend to take on fees. Not in the PoC.

## The line

**We monetize the payment rail we built. We never monetize movement of funds we don't control.**

That sentence is the whole strategy. It is coherent to a regulator (we charge for software and a rail, not for transmitting value), coherent to an investor (a real take rate on a real product), and it is why the swap is free.

Corollaries, all hard:

- **No cut on swaps. Ever.** Not a fee, not a spread, not client-side, not server-side. See the non-custodial non-negotiable in `CLAUDE.md`.
- **The payer never pays.** Ever. Not in P2P, not at a merchant.
- **The recipient pays, and only when they're acting as a business.**

## The tier is a *mode*, not a dollar amount

**Superseded:** the earlier "~$200/month received free, then 0.5%" volume allowance. It's replaced by the following, which is strictly better — mainly because it deletes the sybil surface rather than tolerating it.

| | **P2P mode** | **Merchant mode** |
|---|---|---|
| Price | **Free forever** | **~0.5% of received volume, from dollar one** |
| Identity | raw principal, no handle | claimed merchant handle, shown to payer |
| Devices | one | many (staff terminals) |
| Refunds | send money back manually | first-class, keyed to the original payment |
| Reporting | transaction list | statements, per-staff breakdown, export |

P2P free forever is not charity — it's the growth engine. Charging someone to receive money from a friend is bad product and a worse story.

### Why the leak is fine

A small seller can just take payments as a *person* and pay nothing. **Good.** That's the market stall, the coffee cart, the friend who sells jam — they are growth, not revenue, and they were never going to pay you. They upgrade the day they want a name customers recognize, a second cashier, and a report for their accountant. Self-selecting, honest, and exactly how Square and Stripe convert.

There is no allowance to game, because there is no allowance.

## The merchant features — chosen by one test

The test is **not** "what's valuable." It's:

> **Does this feature lose its value if the merchant splits into five accounts?**

That property is what *replaces* sybil resistance. We are not defending a free tier; we are making the attack self-defeating. Only features that pass belong in merchant mode.

### 1. A durable merchant handle, shown at approval

The payer's screen reads **"Pay $12.40 to Blue Bottle Coffee"** — not a principal hash — *before* they approve.

This is the anchor feature.

- **It's the answer to QR-swap fraud** (someone stickers a fake QR over yours — endemic on Alipay/WeChat/UPI). This is the first thing a sharp investor asks about any QR payment product; we should have an answer.
- **It's anti-sybil by construction.** A handle accrues recognizability and age. Splitting resets it to zero.
- Merchants pay for it because it *converts customers*.

**Hard constraint: this must never become KYC.** No document check, no vouching, no attestation of legal identity. It is a first-come, claimed, non-transferable name — Twitter-handle semantics. The UI may say *"claimed, receiving since March 2026."* It must never say *"dpay verifies this is a real business."* The moment we attest to identity we've bought the licensing problem we spent the whole architecture avoiding.

### 2. Multi-device / staff terminals

One merchant account, several cashier phones. Splitting doesn't merely fail to help — it makes the merchant's life *worse*, because every cashier becomes a separate business.

### 3. Refunds, keyed to the original payment

References the original nonce; partial refunds supported; the customer sees **"Refunded ✓"** rather than a mystery payment from a stranger. Splitting → *which of my five accounts took that payment?*

Note we **structurally cannot offer chargebacks** — that requires reversal power over user funds, which we do not and will not have. Refunds are our entire answer to the dispute question, so they have to be excellent. This is a real competitive gap against cards and we should be ready to answer it, not surprised by it.

### 4. Consolidated settlement reports

Daily/monthly statements, per-staff breakdown, tax export. Splitting → five disjoint reports merged by hand at midnight.

### What these four have in common

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
- The **merchant is online** and consents by using dpay in merchant mode.
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
| **dpay** | **~0.5%** |

Marginal COGS is a canister call. Gross margin is close to absurd. *"0.5% vs 2.9%, and our cost of goods is a smart contract execution"* is a better slide than any free tier.

## Open

**Keep the relay bypassable and self-hostable** — a merchant must always be able to submit straight to ICP; the relay is a convenience, never a chokepoint. MiCA's *"transfer services for crypto-assets on behalf of clients"* is an activity test independent of custody, and it bites a mandatory chokepoint far harder than an optional one. Costs ~nothing architecturally. Settle before the pilot.

## Not in scope

None of this is in the PoC. The PoC proves offline pay. Fees, handles, terminals, refunds, and reports all come after.
