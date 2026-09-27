# Red-line supersessions for automated conversion (2026-09-26)

**Status:** Accepted (founder directive, this session).
**Supersedes parts of:** `2026-09-08-multi-venue-readiness.md` (the 2026-09-11 no-preselection line).
**Refines:** `2026-09-07-delegated-conversion-spec.md` (the consent shape for composed routes).

## What changed

The founder's directive: getting from a held asset to a target currency must be two
button clicks. Everything between is automated by dpay. "Several venues side by
side, none preselected, the user picks" (2026-09-11) is superseded for the default
path: dpay auto-picks the venue.

### Venue auto-pick (supersedes no-preselection)

- Default venue = highest net quoted output among live quotes for the chosen route,
  re-queried fresh at the confirm gesture.
- Disclosure is mechanical, not editorial: "Executed via ICPSwap, highest quoted
  rate of 2 venues, fetched 14:32:05". A single venue renders one attributed line.
- Other venues remain reachable: an expander lists every other venue's row verbatim
  in registry order; one tap overrides the auto-pick.
- The word "best" never appears in UI copy. The venue's own quote is attributed and
  timestamped; dpay never computes, blends, or ranks quotes. (Display precision on the
  sheet's hero is a rendering rule, not quote handling — see the subsection below.)

### Red lines that remain (unchanged)

- dpay is never counterparty, never custodian, holds no keys, takes no cut. The
  user's own device signs every leg.
- Quotes are the venue's own, shown attributed and timestamped.
- CCTP-style external-sign routes are opt-in rows only; never the auto-pick while a
  device-signable path exists.

### Display precision of the receive hero (round-1 validation, decided 2026-09-26)

- The sheet's receive HERO renders the venue's figure at the asset class's
  standard display precision (currency-class outs at 2 decimals; token-class
  outs at their registry display precision, e.g. ckETH 6, ckBTC 8), with the
  one ≈ carried by the copy. This is PRESENTATION ONLY.
- The venue's figure itself is never altered where money is committed: the
  verbatim attributed + timestamped quote renders in the sheet's Details
  (`convert-quote-verbatim`), and the tracker, the persisted record and the
  receipt all keep the verbatim figures. "Never computes, blends, ranks"
  governs the quote and stands; display truncation on the hero (truncate, never
  round up) is a rendering rule, not a re-quote.
- Pinned both ways: jest (`convertMode`, hero rounded AND verbatim present in
  Details) and the convert e2e family (flows 140/166/168/184/190/194/213).

### CeFi deposit-leg consent shape (refines 2026-09-07; folded to ONE consent 2026-09-26)

For a composed route (e.g. VCHF -> ICP -> EURC via a CeFi venue):

- ONE consent, at the Convert CTA. The venue and its locked settle figure are disclosed
  BEFORE the tap (the venue's own attributed + timestamped quote on the sheet); the
  venue's deposit address does not exist until the order does, so it is disclosed LIVE
  during execution — the Settlement Field tracker narrates order created -> deposit
  address revealed -> exact amount -> signing -> sent -> payout watch -> done/failed.
- The CeFi order is created BEFORE any signature (order-first prepare): no byte is signed
  before the venue's deposit address and locked figure exist.
- The confirm re-quotes fresh: a moved IC quote re-arms the button with the old/new
  inline note and creates NOTHING. This is the one exception to the 2-press grammar.
- Exact-amount check: the signed ICRC-1 transfer must match the order's required
  amount exactly; mismatch refuses at prepare and at the deposit gate.
- The signed transfer is frozen bytes: a resume resubmits identical bytes or refuses,
  never re-signs a new one.
- Definitive refusal is terminal (no retry). Expiry refuses with the concrete next
  action.

## Compensating controls for the supersession

- Other-venues expander: registry order, verbatim quotes, one-tap override.
- Details disclosure on the review card: slippage, fees, counterparty, refusal
  terms, minimum received.
- Quote-changed re-confirm: movement between quote and confirm re-arms the button
  with an extra tap.
- Fail-closed no-path states that name the pairs that would work and the next
  practical action.
