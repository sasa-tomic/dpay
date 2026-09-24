# Monetization — direction (decided shape; numbers TBD)

This is the direction we intend to take on fees. Not in the PoC.

## The line

**We monetize the payment rail we built. We never monetize movement of funds we don't control.**

That sentence is the whole strategy. It is coherent to a regulator (we charge for software and a rail, not for transmitting value), and coherent to an investor (a real take rate on a real product).

Corollaries (each carries its own strength — read the bullet, don't assume):

- **dpay never swaps on its own book, and never takes price risk.** See the non-custodial non-negotiable in `CLAUDE.md`.
- **A cut on a third party's swap is open, not decided.** Taking a fee or spread on a conversion a licensed partner performs was foreclosed here by prose (`0aa1bdf`), not by a decision. It is real revenue — MetaMask is the worked example, though verify their current fee and what it actually earns before relying on it. It is also **separable from routing**: we can take a cut without routing, or route without taking a cut. Routing is the clause with legal weight, because picking the provider or displaying a rate is what turns a wallet into a broker. Decide both deliberately; do not inherit either. Whatever is decided is bound by the disclosure requirements drafted in `positioning.md` — a cut the user cannot see itemised fails them. Regulatory evidence bearing on this decision: `docs/REGULATORY.md`.
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

**Hard constraint: the badge must not claim a check that didn't happen.** As built it asserts history on dpay — *"receiving since March 2026"* — and nothing more, so today it must not say *"dpay verifies this is a real business."* A badge that means "paid us" while implying identity was checked is a lie to the person about to hand over money.

Whether dpay ever adds an identity check, directly or through a licensed third party, is **open** — `CLAUDE.md` scope lists login/KYC as deferred, not excluded, and the fiat on-ramp shape in `FUNDING.md` already puts a licensed provider in that role. Running checks ourselves is a cost-and-perimeter decision to weigh when it comes up, not a settled prohibition. What is not open is the honesty: if the badge ever reflects a verification, it names who verified and what they checked.

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

- **Static counter QR** ("the sign at the checkout"). Note the payer enters the amount, so consent gets *stronger*, not weaker — the payer's signature still binds amount+payee, with a payer-generated nonce. This is the dominant small-merchant form factor on UPI/Alipay. Still unbuilt, and **not** the merchant counter that shipped 2026-09-04, which is its inverse: there the merchant keys the price and the charge's own reference is the nonce (`OPEN_ISSUES.md`).
- Webhooks / POS integration
- Tips
- Invoices / recurring

## How the fee is collected — OPEN; the old answer died with the cutover

**Superseded 2026-08-19/20, corrected here 2026-09-04.** This section used to say the canister credits
the merchant `amount - fee` and dpay `fee` from a public fee schedule held in canister state — an
ordinary ledger fee, no protocol change. That answer depended on the facade sitting on the value
path, and it does not: a payment is an app-signed `icrc1_transfer` straight to the asset's own
ledger, with no dpay canister in the path at all (`docs/CANISTERS.md`). A canister that never sees
the transfer cannot take a cut of it.

So **how an add-on fee is collected is open, and nothing here is decided.** Three constraints from
the old design survive the cutover and bind whatever replaces it:

- **The payer never pays and never signs a fee.** Do not add a `fee` field to the signed
  authorization: it would bind a value an offline payer cannot know, and buys nothing in consent.
- **The offline path stays untouched.** A mechanism that changes what the offline payer signs is
  refused on that ground alone.
- **The merchant is online and consents by enabling add-ons**, so collection can be a merchant-side
  arrangement rather than a payer-side one. That is a direction to evaluate against the
  no-custody non-negotiable, not a plan.

## Consequence: whoever holds the keys is load-bearing

**Rewritten 2026-09-04.** The old argument ran: the canister computes the fee, so whoever can upgrade
it can set `fee = 100%` — therefore blackhole the controller or hand it to SNS/NNS. Both halves are
now wrong. The canister is off the value path (above), and the conclusion contradicts the founder's
standing posture, which is no NNS/SNS handoff until critical mass and safety *without* one. That
stance and the strategy behind it live in `docs/GOVERNANCE.md`; they are not re-derived here.

What survives is the shape of the question: a rate any single party can change unilaterally is a
trust event, so whatever mechanism replaces the one above has to make its rate publicly checkable
rather than merely promised.

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

**Keep the relay bypassable and self-hostable** — a merchant must always be able to submit straight to ICP; the relay is a convenience, never a chokepoint. A mandatory chokepoint carries far more regulatory weight than an optional one — `docs/REGULATORY.md`. Costs ~nothing architecturally. Settle before the pilot.

## Not in scope

None of this is in the PoC. The PoC proves offline pay. Fees, badges, terminals, refunds, and reports all come after.
