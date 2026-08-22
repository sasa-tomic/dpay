# 2026-08-22 - Trip Ready: onboarding, delight, and marketing plan

> **STATUS: PROPOSED. NO IMPLEMENTATION YET.**
>
> Founder directive: make dpay more fun to use through a quick first-time walkthrough,
> capability education, clear non-custodial explanations, achievements, animations, and any
> other mechanism that genuinely improves the product. Use only ideas with a strong behavioral,
> ethical, and product rationale.
>
> **NON-NEGOTIABLE CREATIVE BAR:** the resulting UI and animations must look **FABULOUS**.
> They must be exceptionally polished, breathtakingly clear, beautifully composed, premium,
> distinctive, joyful, and genuinely unforgettable. This is not permission for visual noise or
> gratuitous spectacle. It is a demand for world-class art direction, exquisite motion, flawless
> hierarchy, superb typography, and delightful details that make dpay feel like a category-defining
> travel product. A merely functional, conventional, template-like, or "good enough" result is a
> failure. The implementation must not look like generic fintech, generic crypto, generic mobile
> onboarding, or AI-generated design slop.

## Executive concept

dpay should not feel like a game that rewards spending. It should feel like a beautifully stamped
travel document after the user proves something remarkable:

> **The phone loses signal. The payment still works.**

The umbrella product concept is **Trip Ready**, expressed through the existing Traveler Paper
identity. Delight comes from four psychologically sound sources:

1. **Magic:** "I just paid in airplane mode."
2. **Mastery:** "I understand exactly how this works."
3. **Identity:** "I am prepared to travel."
4. **Relief:** "My money is still mine."

The central campaign line is:

# Roaming off. Payment on.

This line communicates the distinctive benefit in four words and gives onboarding, product motion,
success states, demonstrations, and marketing one coherent narrative.

## Product truths that must remain exact

Every screen, animation, achievement, and marketing asset must preserve these truths:

- The payer's phone may be offline; the merchant needs connectivity to submit and settle.
- The user's payment key stays on the user's device. dpay cannot approve a payment for the user.
- The merchant requests an exact settlement asset. dpay does not silently swap another balance.
- Approval is not confirmation. Pending and unknown outcomes must never look successful.
- Only a confirmed settlement may receive a success celebration.
- IC and Solana are parallel rails inside one wallet, not separate product experiences.
- Recovery remains a serious, mandatory ownership step. Delight must not weaken the backup gate.
- Copy should describe user-visible consequences, not rely on crypto or protocol jargon.

## Experience principles

### Fun means confidence, not compulsion

Reward preparedness, comprehension, and meaningful firsts. Never reward transaction count, amount
spent, balance size, frequency, or risk-taking.

### Teach through a traveler story

Use a concrete traveler-and-merchant narrative rather than abstract feature lists. People remember
causal stories better than terminology.

### Reveal complexity at the moment of need

The initial story should be extremely short. Exact-asset behavior, offline handoff, pending states,
and deposit mechanics should receive contextual explanations when first encountered.

### Motion must communicate state

Every animation should explain a real transition, direct attention, or create a meaningful memory.
Decorative movement that delays action or obscures status does not belong.

### Premium calm, then one extraordinary peak

Most financial interactions should feel calm, fast, and trustworthy. The first confirmed offline
payment is the emotional peak and may be dramatically more memorable, while remaining elegant.

## Journey 1: the 25-second first-run story

Place a three-scene, skippable story before wallet creation. It must also be replayable from
Settings as **How dpay works**. Progress, Skip, Back, and Continue controls must be obvious without
competing with the story.

### Scene 1: Roaming off. Payment on.

**Primary copy**

> **Your phone can pay without signal.**  
> The shop uses its connection to complete the payment.

**Visual story**

A traveler phone and merchant phone appear as exquisite paper-cut or editorial illustrations.
Signal bars disappear from the traveler phone. The payment path continues visibly through the
merchant phone and resolves into a confirmed mark.

**Why it works**

This immediately explains dpay's unique connectivity asymmetry through cause and effect. It turns
an unfamiliar protocol into a relatable travel moment and opens with the strongest emotional hook.

### Scene 2: Your money stays yours

**Primary copy**

> **Your payment key is created on this device.**  
> dpay cannot approve a payment for you.

**Visual story**

A beautifully drawn key or authorization seal forms inside the traveler phone and remains there.
The composition should communicate control without using padlock cliches, cyberpunk imagery, or
fake technical diagrams.

**Why it works**

"Non-custodial" is jargon. The concrete consequence users care about is who can authorize their
money. Perceived control is a major driver of trust in financial products.

### Scene 3: Exact asset. No surprise swap.

**Primary copy**

> **The shop requests an asset. You review that exact asset.**  
> dpay never converts another balance behind your back.

**Visual story**

The merchant requests a small USDC payment. The matching balance is selected while other assets
remain visibly untouched. Avoid exchange arrows, price charts, or anything suggesting conversion.

**Why it works**

This establishes the correct multi-asset mental model before users see balances. It reframes no-swap
behavior as a transparent trust promise rather than a missing feature.

### Exit into ownership

After the third scene, present **Create wallet** and **Restore wallet** with equal clarity. The
walkthrough must not bury restoration or imply that dpay owns an account on the user's behalf.

## Journey 2: make recovery an ownership ritual

Keep the recovery-word gate mandatory. Reframe it from administrative friction into a meaningful
moment:

> **This is the moment the wallet becomes yours.**

After the user completes the existing recovery acknowledgment, award the first private capability
stamp:

> **RECOVERY SAVED**

Do not claim that the wallet is "secure" solely because an acknowledgment was checked. Do not make
the animation so celebratory that users rush through reading or storing the words.

**Why it works:** the user has invested effort in protecting something they own. This uses
commitment and the endowment effect constructively while reinforcing self-custody.

## Journey 3: rehearse the payment magic

Do not drop a new user directly into an unexplained scanner after backup. Offer a concise, optional
animated rehearsal:

1. **Merchant requests** an exact amount and asset.
2. **You review and approve** on your phone.
3. **Merchant settles** using its connection.

End with:

> **That's it. Your phone can be offline for approval and handoff.**

Offer two actions:

- **Try with demo funds**
- **Explore wallet**

This must be an explanation or a real demo flow, never a fabricated transaction that presents a
fake Paid or Received state.

**Why it works:** demonstration reduces uncertainty more effectively than prose. An optional choice
preserves autonomy and avoids trapping experienced users in a tutorial.

## Journey 4: teach once, in context

Add short first-use explanations where the information becomes relevant. They should be anchored
to the active surface, dismissible, remembered after dismissal, and replayable through help.

| Surface | First-use explanation | Psychological purpose |
|---|---|---|
| Pay | **Tap the merchant's phone or scan their request.** | Converts an empty scanner into an obvious action. |
| Payment review | **The amount, recipient, and asset cannot change after you approve.** | Reduces approval anxiety through specificity. |
| Receive | **Choose the asset you want to receive. The payer must hold that exact asset.** | Prevents wrong-asset expectations. |
| My address | **Use this to add funds from another wallet.** | Separates funding from merchant payment requests. |
| Offline signed QR | **Authorized, not confirmed. The merchant still needs to submit it.** | Prevents false-success interpretation. |
| Pending | **We're still checking settlement. Do not pay again yet.** | Prevents accidental duplicate payment attempts. |

**Why it works:** information learned while performing a relevant action is retained better than
information in a long generic tour. One-time coaching also keeps the mature product quiet.

## Journey 5: a private capability passport

Introduce a finite **Trip Readiness** card, styled as a modern travel credential rather than a game
dashboard. It tracks capabilities, not financial activity:

- **Recovery saved**
- **Payment flow understood**
- **Funds ready**
- **Tap or scan tested**

Completing all four produces:

> **TRIP READY**  
> You can pay even when your phone has no signal.

The card should show endowed progress after backup, using the goal-gradient effect without pressure.
After completion it should collapse into Settings instead of permanently occupying the wallet.

Optional private firsts may be recorded later, only if they remain sparse and meaningful:

- First QR payment confirmed
- First tap payment confirmed
- First offline payment confirmed
- First payment received

No amounts, counts, dates, counterparties, locations, public profiles, or comparisons should be
shown. The record should be private and preferably local to the user's device.

**Why it works:** self-determination theory supports rewards for competence and preparedness. A
finite readiness journey builds confidence without turning money movement into a behavioral loop.

## Motion and visual art direction

### The mandatory fabulousness standard

The animation and UI implementation must be **absolutely fabulous, spectacularly polished, and
visually exceptional**. Every frame should look intentionally art-directed. Transitions must feel
silky, luxurious, responsive, and alive. Typography must be immaculate. Spacing must be superb.
Illustrations must be distinctive and editorial. Success moments must be joyful enough to make a
user want to show a friend, yet refined enough to preserve financial trust.

The implementation agent must not interpret "restrained" as dull, static, timid, or unfinished.
Restraint means outstanding taste: fewer elements, executed magnificently. It should feel like the
work of an elite product-design and motion studio, not a component library with fades added.

The creative standard is not satisfied by:

- Stock Lottie animations or generic confetti
- Default easing, arbitrary fades, or elements sliding without narrative purpose
- Emoji, clip art, neon crypto effects, glassmorphism pasted onto existing layouts, or 3D coins
- Generic onboarding cards with an icon above a heading
- Reusing the same bounce, pulse, or scale effect on every state
- Excessive motion that makes the app slower, less legible, or less trustworthy
- Beauty visible only in static mockups while intermediate states look unfinished
- A visually gorgeous false success, ambiguous pending state, or inaccessible experience

### Traveler Paper motion language

Extend warm porcelain, ink, tangerine, Space Grotesk, paper surfaces, fine rules, and travel-document
details. Explore motion inspired by passport stamps, itinerary lines, boarding-card reveals,
letterpress impressions, and precisely folded paper. These references should be abstract and modern,
never kitsch or literal scrapbook decoration.

Use tangerine as a moment of energy and focus, not as a wash over every screen. Success green remains
reserved for confirmed success. White QR cards and scan contrast remain functionally untouched.

### State-specific motion

**Onboarding:** create one continuous visual journey across all three scenes. Shared elements should
transform between scenes so the story feels cinematic and cohesive rather than like disconnected
slides.

**NFC listening:** use a subtle breathing field or finely drawn contact waves that suggest proximity
without falsely suggesting progress.

**Linking:** bring the two device forms into an intentional visual relationship. The movement should
feel magnetic and precise.

**Exchanging:** show authorization traveling from payer to merchant, never money leaving before the
user approves.

**Settling:** move the handoff visibly from merchant toward the network, making the merchant's online
role understandable.

**Confirmed success:** land a tactile tangerine Traveler Paper stamp that resolves into the existing
clear confirmation state. The animation should be brief, astonishingly smooth, and non-blocking.

**First confirmed offline payment:** give this one moment the most extraordinary treatment in the
product. Use the line **Roaming off. Payment on.** It should be dazzling, emotionally resonant, and
deeply memorable without resembling a casino reward.

**Pending or unknown:** use quiet, unresolved motion. Never use the stamp, a check, celebratory color,
or any terminal flourish.

**Error or decline:** stop momentum cleanly, explain what happened, and provide the next action. Avoid
punitive shaking or dramatic red flashes.

### Motion constraints

- Motion must never block approval, scanning, navigation, or status comprehension.
- Every animation needs a reduced-motion equivalent that preserves meaning and beauty.
- Interruptions, app backgrounding, rotation, and repeated renders must not replay rewards incorrectly.
- A completed animation must leave the UI in a crisp, stable, useful state.
- Celebration is allowed only after authoritative confirmation.
- IC and Solana must receive equivalent quality and truthful rail-specific states.
- Performance must remain excellent on realistic Android hardware, not only a desktop browser.

## Marketing system

### Hero promise

> # Roaming off. Payment on.
>
> Tap to pay abroad, even when your phone has no signal. Your key stays on your device. You approve
> the exact asset. The merchant completes the payment using its connection.

### The eight-second proof

The primary campaign asset should be an uncut demonstration:

1. The traveler enables airplane mode.
2. The traveler taps the merchant phone.
3. The merchant shows **Received**.
4. The traveler shows **Paid**.

Overlay:

> **Traveler: offline**  
> **Merchant: online**  
> **Settled**

The video must be honest about timing and confirmation. If settlement takes longer than the desired
edit, do not fake an instantaneous result; show the real state transition beautifully.

### Landing-page narrative

1. Open with the travel connectivity problem.
2. Show the airplane-mode proof immediately.
3. Explain merchant request, payer approval, and merchant settlement.
4. Explain device-held authorization in concrete language.
5. Explain exact-asset settlement and no silent swapping.
6. Show supported assets only after the mental model is clear.
7. End with the wallet action or download.

Do not lead with Internet Computer, Solana, cryptography, chain-key assets, or protocol architecture.
Those are supporting proof for interested readers, not the consumer proposition.

## Explicit exclusions

### Public leaderboards and ranks

Reject them. They expose or imply financial behavior, invite manipulation, create privacy concerns,
and turn a trustworthy payment tool into a status competition.

### XP tied to spending or transaction count

Reject it. It encourages unnecessary financial behavior and makes dpay feel speculative.

### Daily streaks, missions, and loss-aversion prompts

Reject them. Missing a day should never create anxiety in a wallet. A good payment product is there
when needed; it does not manufacture reasons to move money.

### Tokens, random rewards, or monetary prizes

Reject them. They attract reward hunters, create abuse and regulatory risk, and distract from dpay's
real differentiator.

### Location-based passport stamps

Reject them unless a future design can prove compelling value without tracking. Travel location is
sensitive data and the decorative benefit is insufficient.

### Celebration on every payment

Reject it. Repetition cheapens the peak moment, slows routine use, and damages financial seriousness.

### Mandatory quizzes or a long product tour

Reject them. Comprehension should be verified through clear behavior and contextual teaching, not a
school-like obstacle before wallet access.

## Delivery phases

### Phase 0: canonical narrative and state contract

- Finalize the three onboarding truths and exact copy.
- Inventory every payment state on IC and Solana.
- Define which states may animate, celebrate, or award a capability stamp.
- Define persistence and replay behavior for walkthroughs and private progress.
- Produce a motion storyboard before implementation begins.

**Exit criterion:** no copy, animation, or reward can misrepresent custody, connectivity, asset
selection, authorization, pending status, or settlement.

### Phase 1: first-run story and recovery ritual

- Build the three-scene walkthrough.
- Preserve Create/Restore and the mandatory recovery gate.
- Add **How dpay works** replay in Settings.
- Add the Recovery Saved capability moment.
- Cover skip, replay, restore, existing-user, failed-faucet, and reduced-motion paths.

**Exit criterion:** a new user can accurately explain the connectivity and authorization model after
less than 30 seconds, and the result is visually extraordinary on desktop and Android.

### Phase 2: rehearsal and contextual coaching

- Add the three-step payment rehearsal.
- Add one-time coaching for Pay, review, Receive, funding, offline handoff, and pending.
- Ensure all coaching is dismissible, replayable, and absent after completion.
- Add coverage for every first-use and returning-user branch.

**Exit criterion:** no primary surface assumes an unexplained mental model, and mature use remains
fast and uncluttered.

### Phase 3: functional motion and the peak moment

- Implement the state-driven NFC and settlement motion system.
- Add confirmed-success stamp motion.
- Add the unique first-confirmed-offline-payment experience.
- Implement reduced-motion and interruption behavior.
- Verify that pending, unknown, decline, and error can never enter success motion.

**Exit criterion:** motion is breathtaking, truthful, fast, accessible, and mapped one-to-one to
authoritative states.

### Phase 4: Trip Readiness passport

- Add the finite four-capability card.
- Award progress only from verifiable product events.
- Collapse it after completion and keep it private.
- Evaluate optional firsts only after the core journey proves useful.

**Exit criterion:** readiness increases confidence and activation without increasing unnecessary
transactions or permanent dashboard clutter.

### Phase 5: campaign and landing experience

- Produce the honest airplane-mode proof.
- Align landing, store media, demo script, and in-product wording.
- Show the finished, fabulous product UI rather than mockups that exceed the app's quality.
- Validate every claim against actual behavior.

**Exit criterion:** a viewer understands the differentiator in eight seconds and the product fully
delivers the beauty and clarity promised by the campaign.

## Implementation quality gates

The future implementation must follow the repository's full-exercise rule and all path-triggered
device gates. At minimum, its implementation plan must include:

- New or updated Jest coverage for persistence, branches, state-to-motion mapping, and reduced motion.
- New e2e flows for walkthrough complete, skip, replay, restore, contextual coaching, progress, and
  every confirmed/pending/error reward boundary.
- `just verify` after complete implementation, with `FLOWS.md` regenerated from flow metadata.
- `just app` for real RN-to-Android validation.
- `just ondevice` for native/NFC paths affected by the work.
- `just campreview` for any scan-screen layout change.
- Production catalog and real-relay reconciliation for balance or catalog rendering changes.
- Visual baselines reseeded only after intentional design approval.

### Mandatory visual review loop

Automated green checks do not prove fabulousness. Every major scene and every intermediate state must
be captured at realistic phone dimensions and reviewed visually. Use screenshots and video, then use
zai-vision for an independent UI and motion-quality audit. Iterate until the result has:

- Exceptional hierarchy at a glance
- Flawless spacing, alignment, typography, and contrast
- Gorgeous continuity between animation keyframes and stable screens
- No generic placeholders, awkward empty space, clipping, jitter, or half-finished transition states
- Equally excellent light/dark behavior if both themes are exposed
- Excellent mobile rendering under Android system bars and realistic device constraints
- Clear reduced-motion behavior
- No visual implication of success before confirmation

The implementer must not declare completion based only on tests or static code review. The exact
flows touched must be exercised end to end, all branches audited, and the visual result must be
demonstrably magnificent. If the UI is merely competent, continue iterating.

## Measurement plan

### Comprehension

- At least 85% of pilot users identify that the merchant needs connectivity.
- At least 85% identify that only their device can authorize a payment.
- At least 85% understand that dpay does not substitute another asset.
- Users correctly distinguish authorized, pending, and confirmed states.

### Activation

- Walkthrough completion and skip rate
- Recovery completion and abandonment
- Time to first Pay, Receive, demo request, and confirmed payment
- First NFC, QR, and offline-payment completion
- Percentage reaching Trip Ready

### Experience quality

- Users describe the first offline payment as clear, surprising, and trustworthy.
- Visual-quality testing shows the experience feels distinctive rather than generic fintech.
- Routine returning-user payment time does not regress.
- Reduced-motion users retain equivalent comprehension and status clarity.

### Guardrails

- No increase in wrong-asset confusion
- No increase in recovery failures
- No increase in payment errors or scan-to-approval time
- No duplicate-payment behavior caused by unclear pending states
- No false-success feedback
- No new exposure of balances, locations, transaction counts, or counterparties

## Final product test

The work succeeds if a first-time traveler can say all four of these without prompting:

1. **"I can pay even when my phone has no signal."**
2. **"The merchant uses their connection to finish it."**
3. **"Only my device can approve my payment."**
4. **"dpay pays the asset I approve; it does not secretly swap another one."**

It succeeds creatively if the traveler also says:

> **"That was absolutely beautiful. I want to show someone."**
