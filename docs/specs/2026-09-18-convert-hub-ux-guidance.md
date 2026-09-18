# Convert hub 2-hop — UX guidance (2026-09-18)

**Research-only deliverable** for the hub-2-hop session. Inputs: `app/components/ConvertMode.tsx`,
`app/convert.ts`, `app/config/convert.ts`, `app/i18n/domains/en/convert.ts`, e2e shots
(140/166/184/188 + ux-*), specs 2026-09-14 §7 and 2026-09-16 §3. Each recommendation is
**MUST / SHOULD / SKIP**. English copy below; de/fr/es translations follow the existing
`convert.ts` domain rules (typed interpolation fns, amounts pre-formatted by `fmtAsset`, no bare
symbol beside a number).

The surface this builds on is already Revolut-class where it counts: one decision number
headline, attributed + timestamped quote, one Details fold, slippage chips, floor line,
fail-closed gates, honest leg list. The hub work must EXTEND that pattern, not fork it.

---

## 1. The destination list — direct vs 2-hop to the same destination (a)

**D1 — MUST. One row per destination asset, never two.** VCHF today will reach
`USDC (Solana)` via Route B AND SideShift; the hub work adds `ckUSDC` via direct pool AND via
ICP. Rendering one row per (destination × mechanism) recreates the clutter Revolut kills
(screenshot 166 already shows `USDC on Solana` twice). Rule: the destination list is keyed by
destination (asset + where it lands); mechanisms live one level down.

**D2 — MUST. Mechanism sub-picker only when >1 mechanism exists.**
- Hub-only destination (ckETH, ckBTC from VCHF/ckUSDC): ONE plain row —
  `convert-dest-inwallet-<asset>` — copy `ckBTC — in this wallet`. No qualifier, no sub-picker,
  nothing to choose. The via-ICP fact appears only on the quote surface (D5).
- Destination with direct pool AND hub route (VCHF→ckUSDC): one row; picking it reveals an
  indented second-level radio group under it — `Direct pool` / `Via ICP` — stable structural
  order (direct first = today's standing default, not a ranking; venues inside each mechanism
  stay never-preselected per V5). Confirm gates until a mechanism is picked (reuse the
  `venueNoneSelected` pattern).
- Cash-out rows (`destRoute`) and CeFi rows keep their slots; D4 merges duplicates.

**D3 — MUST. Preserve the pinned row testIDs.** Flows 184/186/188 + `ux-probe-*` pin
`convert-dest-direct` and `convert-dest-route-<routeId>` (`convert-dest-route-multihop:icpswap-vchf-ckusdc:2` etc.).
Keep those exact IDs on the (possibly re-parented) rows; new rows take
`convert-dest-inwallet-<asset>` and `convert-dest-mech-<routeId>`.

**D4 — SHOULD. Merge existing duplicate destinations under the same rule** (USDC-on-Solana
Route B + SideShift → one row, mechanism sub-rows). This is the same fix the hub work needs;
doing it in the same pass avoids two re-pin rounds. Cost: flows 166/186/187 step re-pins.

**D5 — MUST. Quote fetching follows the ROUTE precedent, not the chooser precedent:**
composed quotes are fetched for the SELECTED destination/mechanism only (as `activeRoute` does
today), not per keystroke across all rows (as venue-chooser mode does). A 2-hop quote is two
pool round-trips; fanning that across rows per keystroke doubles quote traffic for rows nobody
picked. Unpicked mechanism sub-rows carry their label + a static mechanism line (`Via ICP · 2
swaps`), no live number; the picked one shows the composed number on the row and full
attribution in Details.

**D6 — SKIP. Do NOT auto-pick "best" mechanism, ever** — restating the red line because the
hub route will sometimes be cheaper and the temptation will exist. Registry/structural order
only; the user's pick stands even after a re-quote moves the numbers.

## 2. The quote/confirm surface for a selected 2-hop (b)

Keep the 6-line main surface (2026-09-16 result): heading · amount+balance · headline number ·
attribution · floor line · confirm.

**D7 — MUST. In-wallet hub destination uses `receiveHeadline` ("You'll receive"), NOT
`swapPaysLabel`.** `swapPaysLabel` exists to stop cash-out routes promising at-address
delivery; a hub route ENDS in the wallet, so the plain label is the honest one.
ConvertMode.tsx `:1301` currently gates on `routeMode` — gate on "destination is external"
instead. (Hub routes also skip: destination-address input, ckETH gas preflight, cross-fee —
introduce a third branch `hubMode`, don't overload `routeMode`.)

**D8 — MUST. Route chip: a "via ICP" marker under the headline amount.** Small meta line
(testID `convert-route-via`), not a dismissible chip, not a stepper: `via ICP · 2 swaps`.
The user must be able to see which mechanism they picked without opening Details.

**D9 — MUST. The headline number is the COMPOSED estimate (product of the two pool quotes),
and the floor line is the promise.** Copy: `At least X ckBTC stays in this wallet (slippage
floor 1%)` — new key; `routeMinLine`'s "at your address" is false for an in-wallet destination
and must not be reused. Slippage applies per swap; the floor the second leg signs is what the
line states (engine composes minOut₁ → quote₂ → minOut₂).

**D10 — MUST. Per-hop fee fold inside the existing Details block** (no second fold): a
"Two swaps, itemized" section with, per hop: the leg label (reuse `legSwap`),
`poolFeeTier`, the approve fee (new `approveFeeLine` — the existing `inputFeeLine`/"Input fee"
is ambiguous with two hops), and each hop's own `quoteSource` line. **SKIP a total-fees line:**
the fees are in two different units (VCHF approve fee + ICP approve fee), so any total needs an
FX conversion dpay would be inventing. Surplus note (folded): one line covering both hops.

**D11 — MUST. Two attributions, verbatim, never blended into one venue voice.** Main
attribution line: `Quotes from ICPSwap and ICPSwap, fetched 10:23` (new key, `at` = the newer
fetch; each hop's own timestamp lives in Details). If the two hops ride different venue
families later, this line already says so.

**D12 — MUST. Form heading follows the selected destination.** Today `M.convert.heading(inSym,
outSym)` is the direct pair forever (ConvertMode.tsx `:1061`) — with ckBTC picked the screen
must read `Convert VCHF → ckBTC`, matching what the state panels already do
(`routeHeading`). One-line fix, big consistency win.

**D13 — SHOULD. Stale/refresh semantics are unchanged**: 30 s staleness re-quotes BOTH hops;
a moved composed number triggers the existing `quoteChanged` review interrupt. No new copy.

## 3. In-flight: 4 legs (c)

**D14 — MUST. Keep the leg-by-leg list (`convert-route-legs`, `convert-leg-{i}`,
`convert-leg-{i}-state`) fully expanded for 4 legs.** The list IS the progress UI (spec §7:
"no aggregate spinner fiction"); 4 legs is short — collapsing confirmed legs would hide the
only honest progress. Hub legs reuse the existing labels verbatim: `legApprovePull(in)`,
`legSwap(v1, in, hub)`, `legApprovePull(hub)`, `legSwap(v2, hub, out)` — no new leg vocabulary.

**D15 — SHOULD. The top block tracks the CURRENT leg, not leg 1's copy.** During a 4-leg run
the panel shows `approvingBody` (leg-1 wording) while leg 3 executes. Derive the header from
the first non-confirmed leg in `legPlan` (pure render; works regardless of executor step
choreography) and add a counter: `Step 2 of 4 — Swapping VCHF → ICP on ICPSwap`
(new `legProgress(n, total)` + the leg's own label). `executingTitle` stays.

**D16 — MUST. The hop watch reuses `pending_withdrawal` unchanged**: after leg 2 the pool's
`#ok` is not done; the screen parks on `pendingTitle`/`pendingBody(hubSym, …)` until the hub
payout row is SEEN, then signs legs 3–4. No new step vocabulary anywhere in the hub flow
(`approving → pending_withdrawal → done/failed_*/stuck` only).

**D17 — MUST. Done state reuses the DIRECT done copy** (`doneTitle` "Converted" /
`doneBody` "X ckBTC received in your wallet" + `doneTx`): the destination is the wallet, so
hub-done is ordinary-done. The cash-out "on its way" family must not leak in.

## 4. Dead-ends (d)

**D18 — MUST. One terminal meaning for hub `failed_leg`:** "a completed swap is behind you;
the rest refused; your funds are the named asset, in this wallet; the exit is that asset's own
surfaces." Copy (new keys, same family as the cash-out `failedLeg*`):

- `failedHop2Title`: `The second swap was refused`
- `failedHop2Body(hubSym, outSym, reason)`:
  `The first swap went through — you hold ${hubSym} in this wallet, nothing lost and nothing stuck. The ${hubSym} → ${outSym} swap was refused${reason ? `: ${reason}` : ''}.`
- `failedHop2Exit(hubSym)`:
  `Your ${hubSym} is spendable as-is: keep it, convert it later from its own account, or send it. Nothing needs reversing.`

The leg-3 approve refusal (hub ledger refuses the allowance) renders the same trio with
`reason` = the hub ledger's refusal — funds are the hub asset there too. Never render the
cash-out `failedLegExit` (it names Pay ▸ Send-to-address, the wrong exit for an in-wallet hop).

**D19 — SHOULD. Stuck position line.** `stuckRouteBody` says "a leg" generically; hub records
add one line naming the position if the outcome stays unknown past hop 1:
`stuckHoldsLine(hubSym)`: `Completed so far: you hold ${hubSym} in this wallet.`

**D20 — MUST. Pre-swap failures keep today's copy** (`failedApproveBody`,
`failedSwapBody(venue)`): a leg-1/leg-2 refusal is atomic, input unchanged — the hub adds no
new dead-end before value moves.

**D21 — MUST. Insufficient-balance math includes the hub approve fee.** `insufficientLine`'s
"amount plus two ledger fees" becomes "amount plus the fees" with 2 input-ledger fees + the
hub-ledger approve fee for hub mode — otherwise the gate green-lights a conversion that refuses
at leg 3 (a designed dead-end is still a dead end we walked the user into).

## 5. Cheap Revolut-class fixes in the same pass (e)

| # | Pri | File / key | Change |
|---|-----|-----------|--------|
| F1 | SHOULD | `ConvertMode.tsx` RouteStatePanel `:917` + CrossRailStatePanel `:2759` + `multihop.routeHeading` ×4 locales | "Route: ICP → USDC → USDC on Ethereum" (shot 184) reads broken. Collapse when `hopSymbol === destSymbol`: `Route: ICP → USDC (to Ethereum)`. New key or caller-side variant. |
| F2 | SHOULD | `destRoute` / `destDirect` copy ×4 locales | Mechanism-speak on rows: `USDC on Ethereum — swap + cash-out route` → `USDC — to your Ethereum address`; `VCHF — in this wallet (direct swap)` → `VCHF — in this wallet` (the "(direct swap)" qualifier belongs in the D2 sub-picker, where it becomes `Direct pool`). Re-pin 166/184/186/188 copy steps. |
| F3 | SHOULD | `RouteStatePanel` header block (see D15) | Current-leg tracking + `Step n of 4`. |
| F4 | SHOULD | amount row, `S.amountRow` region | Add a `Max` affordance (`btn-convert-max`) next to the balance line — table stakes in swap UX; the parse/insufficient machinery already exists. Note: flow 40/84 visual baselines reseed anyway if D1–D4 land. |
| F5 | SKIP | `confirmButton` ("Re-quote and confirm") | Revolut would say "Convert", but this label IS the signing-gate disclosure (confirm re-quotes before signing) and is pinned across the suite. Keep. |
| F6 | SKIP | SolConvertMode first-destination default | Pinned by flow 189 ("the FIRST (USDC) preselected"); out of hub scope. |

## 6. Do NOT change (f) — red lines and pinned surfaces

1. **V5 chooser mechanics** for every venue choice (including hub hop venues if a hop pair ever
   carries 2+ venue rows): registry order, side-by-side, never ranked/blended/preselected,
   confirm gated on an explicit pick. Hub route v1 inherits `routes.ts`'s one-venue-per-hop
   walk; if a hop pair gains a second venue row, render the existing V5 chooser for THAT hop
   rather than silently binding row 0.
2. **Verbatim attribution**: no composed number presented as one venue's quote; no dpay-fee
   line (none exists — don't add one); no price-impact line on IC surfaces (V8).
3. **Details-fold discipline**: errors, preflights, dead-ends and instructions never fold
   (founder 2026-08-29); only the census folds.
4. **Pinned keys/IDs**: `quoteSource` format, `minReceiveLine` (incl. `'1% slippage'`),
   `convert-leg-{i}`/`-state`, `convert-dest-direct`, `convert-dest-route-<routeId>`,
   `convert-venue-*`, `convert-route-min`, `convert-details`.
5. **The record/render split**: screens render records; the executor re-submits identical
   bytes; confirmed legs are never re-signed (resume cursor = `legPlan` states). No hub screen
   may offer a per-leg re-sign or a fresh quote mid-intent.
6. **`pending_withdrawal` semantics** (pool `#ok` ≠ done; watch the hop ledger) — D16.
7. **Re-quote at confirm + `quoteChanged` interrupt** — the signing gate; hub confirm uses it
   identically (both hops re-quoted fresh, frozen args prepared only after the review passes).
8. **Uniform IA + fail-closed entry**: same Convert gesture for every asset; venue-less assets
   keep the derived unavailable copy (flows 142/170/171); no conversion affordance in Pay/NFC.
9. **The direct pair stays the standing default and first row** where it exists (stable
   structural order — flows 166/188) — D2's sub-picker defaults to it for the same reason.

## 7. Blast radius (for the implementing session)

Re-pin/extend: flows 140, 166, 167, 168, 173, 184, 185, 186, 187, 188 (+ ux-probe harnesses'
row IDs); visual baselines 40/84 (reseed via `e2e-visual-seed` if rows/layout change); jest
`convertMode.test.tsx` (heading D12, headline label D7, floor line D9, dead-ends D18) + a new
`convertHub` engine test; `FLOWS.md` regen; new keys in `en/convert.ts` `multihop` block with
de/fr/es translations in the same change.

New copy keys (EN) — `viaHub`, `hubQuoteSource`, `routeMinWalletLine`, `hubSurplusNote`,
`hubCensusHeading`, `approveFeeLine`, `hubRateLine`, `legProgress`, `destInWallet`,
`mechDirect`, `mechViaHub`, `failedHop2Title/Body/Exit`, `stuckHoldsLine` — as specified in
§2–§4 above.
