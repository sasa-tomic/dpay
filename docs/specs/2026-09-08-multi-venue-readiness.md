# 2026-09-08 — Is the architecture ready to delegate swaps to more than one venue?

Founder question, verbatim: *"I do want to integrate (and delegate actual swaps to) 3rd party
exchanges, so ensure architecture is ready for it."*

**Verdict: no — not for a second DeFi venue, and structurally not for a CeFi one.** The halves that
carry money are fine and generalise without a line of change; everything between the quote and the
signature is welded to one pool.

## What is already ready — do not re-litigate

- `DpayCore.icpSignUpdate(secret, canister, method, argHex, expiry)` is generic over canister and
  method. Any IC venue signs through it unchanged.
- `rail.ts::submitTransfer` takes `{ledger, envelopeHex, requestIdHex}` + an optional reply decoder —
  already venue-agnostic.
- The device submits straight to `icp-api.io`, not through the relay, so `docs/REGULATORY.md` §4
  constraint 3 holds for any IC venue.
- **A CeFi-shaped integration already exists in the tree**: `app/services/opencryptopay.ts` fetches a
  third party's quote, destination and submit endpoints directly from the device — no relay hop, no
  dpay key. That is the shape the first CeFi venue should copy.

## The gaps, in the order they should be closed

| # | Gap | value | effort |
|---|-----|------:|:------:|
| V1 | **There is no venue type at all.** ICPSwap is a module constant duplicated across 11 source files, four of them translations. `ConvertRecord` has no venue field, and `probeConvertSettlement` matches settlement against the module const — a second venue's records would silently never settle-match. Add `venueId` to the record; look venue facts up, never import them. | 9 | M |
| V2 | **The persisted record schema rejects every CeFi record that will ever exist.** `hydrateConvertStore` discards the store unless `approveEnvelopeHex` + `swapEnvelopeHex` + `amountOutMin` are present, and `executeConvert` is two hardcoded legs. Replace with an ordered `legs: SignedLeg[]` (empty for CeFi) plus an optional `providerRef {orderId, statusUrl}`. This is the one change that makes DeFi and CeFi the same shape instead of two code paths. Missing states to add: awaiting-user-authorization, deposit-address-issued/awaiting-deposit, provider-processing, quote-expired, provider-refunded. | 9 | L |
| V3 | **The fake-IC gateway holds ONE pool as a struct field**, so a second venue cannot be tested offline — and the offline loop is the whole dev model. The last time a single pin went unchallenged it shipped a 5.9×-wrong rate to production (see [`2026-09-08-conversion-hardening-plan.md`](2026-09-08-conversion-hardening-plan.md)). Make it a map keyed by principal; the test knob takes a `pool`. | 8 | M |
| V4 | **Venue identity belongs in `dfx/catalog_truth.json` + a `/api/v1/venues` route**, exactly the way the currency catalog already works (compiled authority → route → app cache → two drift alarms → mainnet tripwire). A separate route, not a section of `/api/v1/currencies`: venues are pair-scoped, not asset-scoped. It should carry `venue_id`, `display_name` (kills the i18n duplication), `kind: ic_amm \| cefi`, `endpoint`, the pair as an UNORDERED set of ledger principals (order is read live from the venue), `testnet`, and a `disclosure_key`. The fee tier must NOT be in the table — the relay echoes the venue's own. | 8 | M |
| V5 | **Two venues on one pair cannot be represented, so the no-routing red line is enforced today only by inexpressibility.** The compliant screen is: N venue rows in a stable, quote-independent order, **none preselected**, each with its own quote, attribution and timestamp. The three ways a naive implementation crosses the line: sorting rows by output, auto-selecting an "obviously better" venue, and defaulting to last-used after the rates diverged. Add `venuesForPair()` + `selectedVenueId` state; with one venue the current screen is unchanged. | 8 | M |
| V6 | **The recovery model is "resubmit the same bytes", which dies at the IC ingress expiry** and cannot survive a venue that holds funds for hours. Also: the convert store key is not identity-scoped (unlike every other per-wallet store), the resume path watches only the NEWEST record and only while the screen is mounted, and the settlement probe requires an exact amount match in a 10-row window. | 8 | M |
| V7 | **The relay's swap seam is ICPSwap-shaped**: `swap_pool_quote(pool, zero_for_one, amount_in) -> u128` on the IC-`Ledger` trait, returning a bare integer with no fee tier, quote id or expiry. Widen to a venue quote type. A CeFi venue must NOT be added to this trait — it is an IC-ledger abstraction; put CeFi on the device. | 8 | M |
| V8 | **Quote provenance leaks in three places** while the amount itself is verbatim end-to-end: the screen shows the DEVICE receipt time, not the relay's `fetched_at` (the actual venue-read instant); price impact is dpay arithmetic over a second reference quote, which doubles the call rate per keystroke and is meaningless for a non-curve venue; and the displayed Rate is derived by division rather than published. The app also hard-requires `zero_for_one` to be a boolean, so any venue without an AMM direction flag is rejected as malformed. Rule to write down: display what the venue publishes, derive only what it does not. | 7 | S |
| V9 | **The guarantees are asserted per-flow, not as venue-agnostic invariants.** Nothing would fail if venue #2 crossed a red line. Write these as tests: (1) every signed envelope targets the user's own ledger or an allowlisted venue, never a dpay principal; (2) every beneficiary is the user's own principal; (3) the relay's venue surface stays query-only; (4) the rendered rate byte-equals the venue's reply (mutate the fake, assert the number moves identically); (5) with N>1 venues none is preselected and order is quote-independent; (6) no dpay account is a fee recipient and the paid-nothing line renders on every venue; (7) the approval is bounded — exact amount + fee, `expected_allowance`, expiry ≤ 10 min — per venue; (8) no conversion offer appears anywhere in a payment flow; (9) no swap submit traverses a dpay-hosted origin. | 7 | M |
| V10 | **The relay sits in the quote path for no integrity benefit** — an anonymous IC query is uncertified whether the relay or the device makes it — while being the place every new venue must be registered. Not a PoC blocker, but decide deliberately before deleting the core's `swap_arg` as dead code: it is dead only because the relay owns the quote, and deleting it forecloses the device-side option. | 7 | S |
| V11 | **Convert is gated to `protocol === 'ic'`**, so a Solana venue (Jupiter — the only pair with real depth for the tourist story) cannot reach the screen. Flagged so nobody reads "the Convert screen exists" as "the Convert screen is chain-agnostic". | 5 | M |

## Do these three first

V1, V2, V3 — the venue as a first-class record, legs instead of two hardcoded envelopes, and a fake
that can hold more than one pool. With those, venues two and three are table edits plus one adapter
each. Without them, every venue is a fork of the conversion stack.
