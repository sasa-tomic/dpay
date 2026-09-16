# Convert coverage expansion — more pairs, more venues, quieter screen (2026-09-16)

Founder direction, this session, verbatim:

> "I basically want to allow swaps across as many pairs as possible, using as many platforms as
> possible (ideally 2-3 platforms per pair)"
> "I do want to reuse the existing large platforms for this, and get live quotes from them if
> possible, possibly through our relay (for caching etc)"
> "Also swap screen should have 10x lower verbosity. Low-value information should be dropped or
> hidden by default (e.g. folded behind "details" or "help")"

Frame unchanged: delegated conversion, user-device-signed, venues side-by-side unranked, quotes
verbatim attributed, no dpay cut (`docs/specs/2026-09-07-delegated-conversion-spec.md`).

## 1. Measured pair/venue census (2026-09-16, live, read-only)

ICPSwap factory `4mmnk-kiaaa-aaaag-qbllq-cai` — 875 pools, all `metadata()` answered. Per-ledger
pool counts: ICP 452 · ckUSDC 50 · ckBTC 39 · ckETH 19 · VCHF 10 · **VEUR 0** (no ICPSwap presence
at all — VEUR is not registrable on any surveyed venue; the EUR IC row stays convert-less honestly).

Registrable finds (reserves = pool-side balances, depth hints):

| pool | pair | fee | reserves | verdict |
|---|---|---|---|---|
| `xmiu5-jqaaa-aaaag-qbz7q-cai` | ICP↔ckBTC | 3000 | 1.11 ckBTC / 50,980 ICP | REGISTER — deep (deepest ckBTC pool in the factory; the 2026-09-14 "thin, stay out" verdict is superseded by depth improvement, the doc's own re-registration condition) |
| `akhru-myaaa-aaaag-qcvna-cai` | ckBTC↔ckETH | 3000 | 1.15 ckBTC / 24.63 ckETH | REGISTER — real depth, market-aligned price |
| `hx7nb-diaaa-aaaar-qbxsa-cai` | VCHF↔ckUSDC | 3000 | 1,430.93 VCHF / 505.32 ckUSDC | REGISTER — thin but real; the quote is verbatim, so a thin market discloses itself in its own numbers (the CHF→USD direct pair) |
| `mvcvq-3iaaa-aaaag-qjykq-cai` | ckUSDC↔ckETH | 3000 | 1.40 ckETH / 1,552.45 ckUSDC | REGISTER — thin but real |
| `mhecj-xyaaa-aaaag-qjyjq-cai` | ckUSDC↔ckBTC | 3000 | 0.03 ckBTC / 1,516 ckUSDC | SKIP — dust BTC side |
| `wjpjp-iiaaa-aaaar-qb7kq-cai` | VCHF↔ckBTC | 3000 | 72.41 VCHF / 0.0011 ckBTC | SKIP — dust AND mispriced (p=0.000016 vs ~97,000) |

Jupiter (keyless `lite-api.jup.ag`, both directions live-quoted, `platformFee: null`, ~110 ms):
SOL↔EURC healthy (1 SOL → 84.128313 EURC; reverse fine). **USDC↔EURC SKIP**: the thin market
quotes 10 USDC → 8.667 EURC (~13% spread) — a genuinely bad market at any size; revisit on depth.

Latency: Jupiter ~110 ms stable (pass-through fine; relay cache optional); ICPSwap quotes 50–800 ms
jitter through icp-api.io (metadata cache already load-bearing; no quote cache added — per-user
amount variance limits hit rate).

Second-venue coverage: SideShift row `sideshift-usdc` (ICP↔USDC(Solana)) gives ICP→USDC(SOL) a
second path beside multihop Route B (CCTP) — the first pair with two registered routes from one
screen. Still 503-until-founder-key by design (partner-key infrastructure, unchanged).

## 2. Decisions

1. Register the four ICPSwap pools above + `jupiter-eurc` (SOL↔EURC) + `sideshift-usdc`.
   Pairs: IC 3 → 7 direct (+ Routes A/B/C multihop out of ICP/ckUSDC legs); Solana 1 → 2;
   cross-rail gains a second ICP→USDC(SOL) route.
2. Venue-per-pair honestly bounded by what exists: only ICPSwap is a registrable IC AMM (Kong dead,
   ICDex empty/custodial — feasibility doc), so "2-3 platforms per pair" lands today as: multiple
   POOLS (rows) per venue family + SideShift parallel routes + Jupiter aggregating all of Solana.
   DFX stays gated by its recorded precondition (founder B2B contact, post-DEX-PoC).
3. Jupiter quotes move behind the relay (`POST/GET /api/v1/jupiter/*`) — founder ask ("through our
   relay for caching"), same marker contract as the Solana RPC proxy (R2): upstream statuses
   verbatim, transport death → 504 `jupiter-upstream-unreachable`, byte-faithful pipe for the
   swap-tx POST, short-TTL canonical-params cache on quote GETs only. Keyless: no 503 state.
   Operator override semantics follow R2 (Settings ▸ Advanced endpoint ⇒ relay bases + proxy path).
4. Convert surface verbosity: the audit cut list (below) — deletes of disclaimer-class copy, one
   Details disclosure for the mechanics, three real bugs fixed on the way.
5. SOL surface gains an out-destination picker: `solanaAmmVenueForMint` assumed one venue per mint;
   with `jupiter-eurc` registered, SOL holds TWO out options (USDC, EURC). Enumerate
   `solanaVenuesForMint` and let the user pick the destination; rows in registry order, none
   preselected beyond keeping the current default when it still exists (no ranking).

## 3. Verbosity cut map (audit, applied to `en/convert.ts` ×4 locales)

DELETE: `netEndStateLine` (duplicate of the headline number); `dpayFeeLine` (all 4 render sites —
policy sentence); `disclosures.byKey.icpswap`/`generic` non-party tails and `counterparty`'s
"autonomous … not a licensed provider and not dpay" tails (attribution survives in `quoteSource`);
`sol.quoteFeesNote`; `multihop.routeNote` (UI meta-commentary); `"Quote: "` prefix on chooser rows;
`expiryLine` renders on `failed_refunded`/`failed_leg` (window closed); every "dpay cannot reverse
or speed up…" tail (pin 141:104 moves with it).

FOLD behind one Details disclosure on the quote-ready card (IC + SOL): rate line, trimmed
counterparty ("Executed by the ICPSwap pool"), signing fact, pool principal, pool fee tier,
input/output fee lines, refusal-consequence line, cross-rail hints, `routeSurplusNote`, per-row
chooser timestamps (full attribution stays on the active quote's `quoteSource`).

FIX while there: `crossrail.solReadyBody` double-unit ("10.36 USDC USDC is at …"); cefi deposit
amount line through `fmtAsset`; `UnavailablePanel`'s hardcoded pair list becomes registry-derived.

Result target: quote-ready main surface = heading · amount+balance · "You'll receive" + number ·
attribution line · minimum line · confirm — ~6 copy lines from ~20; every error keeps its practical
instruction (founder hard rule 2026-08-29).

## 4. Blast radius (pinned copy)

Flows 140–145, 166–171, 183–187 + jest `convertMode.test.tsx` (:206 net line, :375 phone-signs),
`convert.test.ts`, `convertMultihop.test.ts`, `convertCrossrail.test.ts`, `sideshift.test.ts`.
Keys NOT touched: `quoteSource`, `minReceiveLine` (incl. `'1% slippage'`), error bodies, leg labels.
Flow 142's unavailable-body assertions re-pin to the derived copy.

## 5. Verification

`just check` + jest + full `just e2e` + `just swap-venue-probe` (new pools join the standing
mainnet tripwire via the truth file) — every touched flow re-run; FLOWS.md regenerated.
