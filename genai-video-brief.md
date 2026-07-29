# dpay — GenAI video brief (two friends, one shop, QR + NFC)

*Paste-ready pack for a real text-to-video model. Concept: two friends walk into a city shop that accepts dpay; one pays by QR (she's offline and has no NFC), the other pays by NFC tap. Shows both payment paths working. Vertical 9:16. Pitch/vision, not a promise.*

## Which tool (as of Jul 2026)

- **Google Veo 3.1 — primary pick.** Best prompt adherence, portrait 4K, native audio, "on-spec first roll" for branded shots. Per-second pricing (~$0.15/s fast).
- **Runway Gen-4.5 — if you want control + brand accuracy.** Camera moves, motion brush, and **reference images** ("Ingredients") so you can feed real photos of the phone/app/banner and keep them consistent — important here, we have specific UI states.
- **Kling 3.0 — cheapest for iterating** (~$0.84 / 10s with audio), multi-shot storyboard, good physical motion.
- **Avoid Sora 2** — being decommissioned in 2026.

## Creative direction / non-negotiables

- **Third-person, two-character story** (two young women). Use **over-the-shoulder / insert close-ups** for phone screens. (This concept supersedes the earlier first-person idea.)
- **Two phones only — no card reader / no POS terminal**, for both QR and NFC. The cashier scans with a **handheld phone**, not a terminal.
- **The merchant signals both methods**: a dpay acceptance banner in the shop shows an **NFC wave icon on one side and a QR code on the other**.
- **Offline stays the flex**: the payer's phone is offline; the shop/cashier is the online side.
- **QR flow is two scans** (matches the real protocol): the payer **scans the merchant's request QR first**, then **shows her own QR for the cashier to scan**.

## Shot list (7 clips, ~4–6s each → cut to ~26s)

Ready-to-paste prompts. Keep phone/banner screens visually simple during generation — crisp UI and the banner are composited in post (see Hybrid trick).

**Shot 1 — Arrival + the banner (establishing)**
> Third-person, two stylish young women walk up to a boutique storefront on a lively city street in daylight; in the shop window is a clean "dpay" acceptance banner with an NFC wave symbol on the left and a QR code on the right; the two read it, smile and nod to each other, and step inside; cinematic, 35mm, shallow depth of field, warm natural light. Vertical 9:16.

**Shot 2 — Inside, shopping (quick beat)**
> Third-person, the two women browsing inside a bright modern shop, each picking up a product they like, candid natural smiles, soft window light, cinematic. Vertical 9:16.

**Shot 3 — Friend 1 at the counter: offline + no NFC**
> Third-person with an over-the-shoulder insert: the first woman at the shop counter glances at her phone; close-up of the screen (keep it clean for a UI overlay) showing a "no internet / offline" state and a "Pay with QR" prompt; she's calm and unbothered; warm interior. Vertical 9:16.

**Shot 4 — Friend 1 pays by QR (two scans)**
> Third-person close-ups: the woman raises her phone to scan a QR code shown on the cashier's handheld phone; then she turns her own phone around to display her QR while the cashier scans it with their phone; a green success check appears; two phones only, no card reader; warm shop interior, cinematic. Vertical 9:16.

**Shot 5 — Friend 2 turns on NFC**
> Third-person with an insert close-up: the second woman presses a control on her phone and an NFC symbol lights up on the screen (keep it clean for a UI overlay); confident, ready; warm interior. Vertical 9:16.

**Shot 6 — Friend 2 taps to pay (phone-to-phone NFC)**
> Third-person macro: the second woman taps the top edge of her phone against the cashier's phone; a soft electric-blue glow pulses at the point of contact; a green success check appears; two phones only, no POS terminal; both smile; warm cinematic interior. Vertical 9:16.

**Shot 7 — Walk out / CTA plate**
> Third-person, the two women leaving the shop together holding small shopping bags, laughing, city daylight; leave clean center headroom for a logo overlay; cinematic. Vertical 9:16.

## Hybrid trick — composite these in post (this is what makes it real *and* on-brand)

GenAI mangles legible on-screen text, logos, and QR codes. Generate the footage, then overlay the real assets in an editor (CapCut / Premiere / After Effects), and pass them as **reference images** to Veo/Runway so the generated screens match. Assets to prepare:

- **dpay acceptance banner** (Shot 1): clean version with the real logo + NFC icon + QR icon on two sides.
- **Friend 1's phone** (Shots 3–4): the "offline / no internet + Pay with QR" prompt screen; her own **payment QR** screen; the "Paid ✓" success. (Pull from `app/shots/` or mock them.)
- **Cashier's phone** (Shot 4): the merchant **request QR** screen.
- **Friend 2's phone** (Shots 5–6): the **NFC-on** screen (NFC symbol); the "Paid ✓ $X" success.

Real, correct, unmistakably your product — and it fixes the QR codes, which must be pixel-accurate to read as real.

## Post / finish

- **Captions (sound-off):** "Two friends. One shop." → "Offline? Pay by QR." → "Or just tap — NFC." → "Both just work."
- **CTA:** dpay wordmark on Shot 7's clean center, "Pay anywhere. Even offline.", small "Coming soon."
- **Audio:** upbeat city/shop ambience + a light beat that hits on each "success" check (Veo/Kling can generate native audio; or add in the editor).
- **Format:** 9:16, ~26s, captions burned in.

## Honest limitations

- **QR codes and logos will not survive generation** — always composite them; never rely on the model to draw them.
- **The two-phone tap and the "scan-then-be-scanned" QR exchange** are specific gestures — expect several takes; the "two phones only, no terminal" phrasing and macro framing help.
- **Character consistency across 7 shots**: use reference images of the two actors (Runway Ingredients / Veo reference frames) so they look like the same two people throughout.

## In-Claude path (optional)

No Sora/Veo/Runway/Kling MCP connector is available in this session, so this pack runs in the tool of your choice. If a generative-video connector gets added (or you want me to check the Adobe/Firefly connector), I can drive the generation and iteration from here.
