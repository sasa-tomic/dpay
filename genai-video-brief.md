# dpay — GenAI video brief (two friends, one shop, QR + NFC)

*Paste-ready pack for a real text-to-video model. Concept: two friends walk into a city shop that accepts dpay; one pays by QR (she's offline), the other pays by NFC tap. Vertical 9:16.*

> **THIS IS FICTION, AND THE SHOP IS THE FICTIONAL PART.** No merchant anywhere accepts dpay today —
> the project is pre-seed at the investor-PoC stage. The scenario is the product's intent, shot as if
> it already existed, which is normal for a teaser and is *only* honest if the finished cut is
> labelled as such and never implies existing adoption. Founder rule this is bound by:
> `CLAUDE.md` → "Non-negotiable: external claims are true, and vision is labelled as vision".

## Which tool — **re-measured against vendor pricing pages 2026-09-04**

Prices move and models retire; **re-verify before any spend.** The previous version of this section
was stamped "as of Jul 2026" and by September three of its four rows were materially wrong.

- **Google — the default is no longer Veo.** Google's own Gemini API docs say to use **Gemini Omni
  Flash** as the default video model (~$0.10/s, 720p) and to reach for **Veo 3.1** only for specific
  capabilities (scene extension, last-frame control, legacy pipelines). Veo 3.1 **Fast** with audio:
  **$0.10** (720p) / **$0.12** (1080p) / **$0.30** (4K); **Standard** with audio: **$0.40** /
  **$0.60** (4K); Lite $0.05–$0.08. Constraints that shape a shot list: **4/6/8-second clips only**,
  **English prompts only**, us-central1 only, and a published retirement date of **2026-11-17 or
  later** — inside the plausible production window for this video.
  *4K is documented on Standard only; 4K-in-9:16 is documented nowhere. Do not promise it.*
- **Runway Gen-4.5 — still current, but it does none of the three things it was picked for.**
  720p only, 2–10 s, ~**$0.12/s** (12 credits/s at $0.01). There is **no camera-control widget or API
  parameter** — camera direction is prompt text (the real feature was Gen-3-only and retired
  2026-07-08). **Motion brush is Gen-2-only and has been dead since 2025-05-11.** And Gen-4.5
  **does not accept reference images** — Runway's own docs say additional inputs are "coming soon".
- **Kling — cheapest, but not the model previously named.** 1 Unit = $0.14. A 10 s clip **with
  audio**: Kling 3.0 720p = **$1.26**, 3.0 Turbo 720p = **$1.12**. The old "$0.84 / 10 s with audio"
  figure is the **silent** 720p row — with audio it is ~50% higher. The genuinely cheapest for
  iterating is **Kling 2.6 / 2.5 Turbo at ~$0.42 / 10 s**. Multi-shot storyboard is real and
  vendor-supported on the 3.0 family (`multi_shot: true`, `shot_type: intelligence`).
- **Sora — do not build on it. It is being switched off in weeks.** The consumer app was
  discontinued **2026-04-26**; the API and Videos API shut down **2026-09-24**, and OpenAI names
  **no replacement**. There is no Sora 3. *Trap:* the pricing page still sells Sora normally with no
  sunset banner — being listed there is not evidence it is safe.

**Consequence for this brief:** the character/brand-consistency plan below cannot rest on Runway
Gen-4.5. If reference-image consistency is required, use a tool that actually accepts references —
Google Flow's *Ingredients to Video* (that is whose feature name "Ingredients" is), or a Runway
model that exposes reference inputs. Otherwise budget for many takes and lock consistency in post.

## Creative direction / non-negotiables

- **Third-person, two-character story** (two young women). Over-the-shoulder / insert close-ups for
  phone screens.
- **Two phones only — no card reader / no POS terminal**, for both QR and NFC. The cashier scans with
  a **handheld phone**. *(Accurate: the payer's phone is the HCE card, the merchant's is the reader.)*
- **The merchant signals both methods** via an acceptance banner (NFC wave one side, QR the other).
  **This banner does not exist — it is a prop to be designed, not an asset to retrieve.**
- **Offline stays the flex**: the payer's phone is offline; the shop/cashier is the online side.
  *(This is the design's one real asymmetry and the single most accurate sentence in the brief.)*
- **The two-scan QR exchange is the OFFLINE branch, not "the protocol".** When the payer has signal,
  the same merchant QR settles in **one** scan — the payer scans, auto-signs and submits, and never
  shows a QR. Shoot the two-scan version *because Friend 1 is offline*, which is the story anyway.

## Shot list (7 clips, ~4–6s each → cut to ~26s)

Keep phone/banner screens visually simple during generation — real UI is composited in post.
Note Veo's 4/6/8 s clip quantisation when timing these.

**Shot 1 — Arrival + the banner (establishing)**
> Third-person, two stylish young women walk up to a boutique storefront on a lively city street in daylight; in the shop window is a clean "dpay" acceptance banner with an NFC wave symbol on the left and a QR code on the right; the two read it, smile and nod to each other, and step inside; cinematic, 35mm, shallow depth of field, warm natural light. Vertical 9:16.

**Shot 2 — Inside, shopping (quick beat)**
> Third-person, the two women browsing inside a bright modern shop, each picking up a product they like, candid natural smiles, soft window light, cinematic. Vertical 9:16.

**Shot 3 — Friend 1 at the counter: offline**
> Third-person with an over-the-shoulder insert: the first woman at the shop counter glances at her phone; close-up of the screen (keep it clean for a UI overlay); she's calm and unbothered; warm interior. Vertical 9:16.

*UI note for the overlay:* there is **no "no internet" screen and no "Pay with QR" prompt** in the
app. The real offline signals are the balance rendered as **"~ DEMO approx."** and the button
**"Pay Now"**; the scanner copy is **"Scan the QR code to pay."** Compositing invented UI onto a
product video is exactly the overstatement the founder rule forbids.

**Shot 4 — Friend 1 pays by QR (two scans, because she is offline)**
> Third-person close-ups: the woman raises her phone to scan a QR code shown on the cashier's handheld phone; then she turns her own phone around to display her QR while the cashier scans it with their phone; two phones only, no card reader; warm shop interior, cinematic. Vertical 9:16.

*UI note:* after an offline hand-off the **payer's** phone shows a **clock icon and "Sent …"**, not a
green check — the check is reserved for a confirmed settle. The **merchant's** phone is where the
success lands. Two green checks would advertise a guarantee the product deliberately refuses to make.
Also: the cashier's second scan is a deliberate button press ("Scan payer's signed QR"), not automatic.

**Shot 5 — Friend 2 is ready to tap**
> Third-person with an insert close-up: the second woman presses a single button on her phone and the screen shows it is ready to pay; confident; warm interior. Vertical 9:16.

*UI note:* there is **no in-app control that turns NFC on** — the status row is read-only and NFC is
an OS Settings action. The one press that exists is **"Pay Now"**, which arms the camera **and** the
NFC card together; there is deliberately no per-payment QR/NFC toggle.

**Shot 6 — Friend 2 taps to pay (phone-to-phone NFC)**
> Third-person macro: the second woman taps the top edge of her phone against the cashier's phone; a soft electric-blue glow pulses at the point of contact; a green success check appears; two phones only, no POS terminal; both smile; warm cinematic interior. Vertical 9:16.

**Shot 7 — Walk out / CTA plate**
> Third-person, the two women leaving the shop together holding small shopping bags, laughing, city daylight; leave clean center headroom for a logo overlay; cinematic. Vertical 9:16.

## Hybrid trick — composite the real UI in post

GenAI mangles legible on-screen text, logos and QR codes. Generate the footage, then overlay real
assets in an editor. **Do not plan on feeding them back as references to Gen-4.5 — it does not take
them** (see the tool section).

Assets to prepare, and where they actually are:

- **dpay acceptance banner** (Shot 1) — **does not exist; design it.**
- **Cashier's phone, merchant request QR** (Shot 4) — `app/shots/02-receive-nfc-status.png` is a real
  capture of exactly this screen.
- **Friend 1's payment QR screen, and the "Paid ✓" success** (Shots 3–4) — **not** in `app/shots/`,
  which holds only three files. The real library is **`e2e/shots/` (250+ PNGs)**: `20-offline-handoff`
  (the payer's signed QR), `07-scan-pay` (Paid ✓), `08-merchant-settle`, `06-request-qr`, `13-offline`.
  Caveat: those are headless `react-native-web` renders, not device captures.
- **Friend 2's tap screens** (Shots 5–6) — `e2e/shots/11-nfc*.png`, `32-nfc-disclosure*.png`.
  Note both usable `app/shots/` captures show NFC **un**available (the emulator has no NFC radio), so
  they cannot stand in for an NFC-ready screen.

## Post / finish

- **Captions (sound-off):** "Two friends. One shop." → "Offline? Pay by QR." → "Or just tap — NFC." →
  "Both just work."
  *Accuracy note:* "Both just work" is proven on hardware for the **Internet Computer** rail (two
  physical phones, 2026-08-26). The Solana rail's own NFC transport has never crossed a radio. Keep
  the caption only if the cut is unmistakably a vision piece.
- **CTA:** ∂pay wordmark on Shot 7's clean center, "Pay differently.", then **"Coming soon."**
  Do not pair a present-tense capability claim with "Coming soon" on the same card — the small type
  loses and the plate reads as a claim about today. Lead the plate with the future-tense label.
- **Audio:** upbeat city/shop ambience + a light beat hitting each success moment.
- **Format:** 9:16, ~26s, captions burned in.

## Honest limitations

- **QR codes and logos will not survive generation** — always composite; never let the model draw them.
- **The two-phone tap and the scan-then-be-scanned exchange** are specific gestures — expect several
  takes; "two phones only, no terminal" phrasing and macro framing help.
- **Character consistency across 7 shots is the unsolved problem here**, precisely because the tool
  previously named for it cannot take references. Decide the approach before generating.

## In-Claude path (optional)

Three generative-media connectors are present in this session — **Comfy**, **Higgsfield**, and
**HyperFrames by HeyGen** — all currently unauthenticated. None of the four vendors above has an MCP
connector here. If you authenticate one of the three, generation and iteration can be driven from here.
