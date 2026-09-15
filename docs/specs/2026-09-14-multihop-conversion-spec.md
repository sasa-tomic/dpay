# Multi-hop conversion as a single user intent — spec (2026-09-14)

**Status:** wave 1 (Route A) implemented. **Supersedes** the 2026-09-07 delegated-conversion
spec's `multi-hop` non-goal — founder decision 2026-09-14 (swap-venue feasibility deep pass,
"Multi-step routes" / "Founder decisions" §2): *a multi-hop conversion is ONE user intent that
orchestrates every leg with per-leg status and honest per-leg recovery — not a chain of
separate screens the user is dropped between.* Everything the 2026-09-07 spec still owns
(§0 red lines, §5 transparency checklist, §4 identical-envelope discipline, V5 no-preselection
venue chooser) applies to EVERY leg unchanged; this spec only widens the record, the executor,
and the screens from one venue hop to an ordered list of them.

## 1. What a multi-hop conversion is

A multi-hop conversion is **one user intent** = an ordered list of IC update legs, **each
independently signed by the user's device**, executed in order. Wave 1 ships exactly one route:

**Route A — ICP → USDC (Ethereum):**
1. `icrc2_approve` on the ICP ledger — spender = the ICPSwap ckUSDC pool (approves the swap pull),
2. `depositFromAndSwap` on the pool — ICP → ckUSDC,
3. `icrc2_approve` on the ckUSDC ledger — spender = the ckETH minter (approves the burn amount),
4. `icrc2_approve` on the ckETH ledger — spender = the ckETH minter (approves the Ethereum gas fee),
5. `withdraw_erc20` on the minter — burns ckUSDC + gas ckETH, delivers USDC to the user's own
   Ethereum address.

ZERO new signing surface: every arg builder already exists (`icpApproveArg`,
`icpDepositAndSwapArg`, `icpWithdrawErc20Arg` in `crates/dpay-ffi/src/icp.rs`); legs 3–5 are the
EXACT calls the standalone Withdraw sheet sequences for a ckERC20 cash-out (dual-ledger approve +
`withdraw_erc20`) — this spec routes them, it does not fork them.

§0 red lines carried over verbatim: dpay is never a party to any leg; the user's device signs
everything; each venue's own quote is displayed verbatim, attributed and timestamped; no dpay fee
or cut anywhere; recipient-side wallet action, never mid-payment.

## 2. Route planning (pure composition, no opinion)

`app/routes.ts` composes routes from the EXISTING registries — no new authority:

- The **swap hop** comes from the venue registry: any bundled `ic_amm` venue whose pair contains
  the input ledger, where the OTHER leg's catalog row is `minter_family: 'CkEthErc20'` with a
  `token_contract`, a `minter`, and a `gas_ledger` — i.e. the pool can mint the input into a
  ckERC20 the minter can burn to its chain. (ckETH itself has no `token_contract` — native-ETH
  `withdraw_eth` is a different leg set and stays out of wave 1; the rule excludes it
  structurally, not by hardcoding "ICP".)
- The **burn side** comes from that row: minter principal, gas ledger, ledger fees.
- Route A falls out: venue `icpswap-ckusdc` (pair ICP/ckUSDC) → burn leg against the ckETH minter
  `sv3dd-oaaaa-aaaar-qacoa-cai`, gas ledger = ckETH ledger.

Destination address: user input, validated by the SAME predicate the send/withdraw rails use
(`isValidDestinationAddress('CkEthErc20', …)` — checksummed-form `0x` + 40 hex). The address is
the user's own; the app never derives or suggests it.

## 3. The record (backward-compatible widening of the v2 store)

`legs: SignedLeg[]` stays exactly as shipped. Additive fields, ALL optional:

- `legPlan: LegPlan[]` — parallel to `legs` (same length, same order): `{kind: 'approve' |
  'swap' | 'approve_gas' | 'withdraw_erc20', canister, fee, state: 'pending'|'sent'|'confirmed'|'failed'}`
  — the per-leg display + resume bookkeeping. `fee` is that leg's own ledger fee (approve legs) or
  the minter's live gas quote (the `approve_gas` leg).
- `destAddress` — the user's Ethereum address (final leg's recipient).
- `destSymbol`, `destNetwork` — what arrives where ("USDC", "Ethereum").
- `hop*` — the intermediate in-wallet asset (`hopLedger`, `hopSymbol`, `hopDecimals`,
  `hopCurrency`), the thing a mid-route failure parks the user holding.

**Backward compat (hard rule):** a record with NO `legPlan` is the shipped single-swap shape —
hydration, recovery, and screens treat it byte-identically to the 2026-09-07 build. Hydration
accepts `legs.length === 2` (no plan) OR `legs.length === legPlan.length ≥ 2` (planned); anything
else was already refused and stays refused. An old build reading a NEW record drops it
(fail-closed, same as today's cross-shape rule) — no migration debt either direction.

## 4. Per-leg state machine

- At **prepare (confirm)**: ALL legs are built and signed in one pass, args frozen — the executor
  only ever re-submits identical bytes (identical-envelope discipline, request_id dedup; NOTHING
  new is ever signed during recovery). `step` starts at `approving`, every plan state `pending`.
- **Per leg, in order:** submit → `sent` → `settled` ⇒ `confirmed` (advance to the next leg);
  refused ⇒ per-leg failure taxonomy below; `unknown` ⇒ the honest `stuck` (unchanged meaning:
  the outcome is unknown, the bytes may have executed, resubmit-only-if-unexpired on resume).
- **The swap leg's confirmation is a LEDGER WATCH, not the #ok alone** (the 2026-09-07 rule
  unchanged): the pool's `#ok` means "input pulled, output owed". The plan marks the swap leg
  `confirmed` only when the ckUSDC payout row (from the pool, at the user's principal, within the
  recorded expected range) is SEEN on the hop ledger. Until then the record parks at
  `pending_withdrawal` — the existing state, existing meaning, existing resume.
- **The final leg's terminal evidence is the minter's `#ok`** (it returns a durable block index):
  the burn is accepted, the EVM delivery is asynchronous and off-view to an IC-only app. `done`
  therefore says "on its way to <address>", never "received" — the honest copy carries the
  destination and the amount the minter was told to deliver.
- **Expiry trichotomy (V6) unchanged:** every leg of one intent shares the envelope ingress
  expiry. Unconfirmed + expired ⇒ never resubmit; probe the hop ledger: payout seen ⇒ the burn
  legs' bytes are dead — park `failed_leg` (funds are the hop asset, in-wallet, exit = standalone
  Withdraw); nothing seen ⇒ `stuck` + slow watch, exactly today.

### Per-leg failure taxonomy (every dead-end names the position + the exit)

| failed leg | state | what the user holds | copy |
|---|---|---|---|
| 1 approve (input) | `failed_refunded` / `approve_refused` | all input, unchanged | today's copy |
| 2 swap | `failed_refunded` / `swap_refused` | all input, unchanged (atomic) | today's copy |
| 3/4/5 burn side | `failed_leg` / `withdraw_refused` (new terminal step) | the HOP asset, in-wallet | "You hold X ckUSDC in this wallet — the cash-out leg was refused (<reason>). Your funds are safe here; exit via the standalone Withdraw (cash out) path, or retry when the cause is fixed." |

`failed_leg` is a terminal step with ONE meaning: the swap completed, the burn side could not
execute, the position is named, the exit is the standalone Withdraw screen. It is never used for
anything pre-swap.

## 5. Fees + quote composition (INV-6 census style — every leg, no dpay cut)

The quote surface renders **each venue's own quote verbatim, per leg** — nothing blended:

- **Leg 1–2 (ICPSwap):** the pool's own quote (attributed, timestamped — the existing checklist
  lines unchanged), the pool's fee tier, the ICP ledger approve fee.
- **Legs 3–5 (minter):** the minter's OWN live `eip_1559_transaction_price` query (the same
  `fetchGasFeeWei` the Withdraw sheet shows), shown as the gas leg's fee in ckETH; the ckUSDC and
  ckETH approve fees from their ledger rows.
- **Total = sum of per-leg fees**, each on its own line, each attributed. `dpay charges nothing`
  on every census — there is no dpay cut on any leg, ever.
- **The amount line is a floor, honestly labeled:** the burn legs are signed for the swap's
  MINIMUM-you'll-receive (the only figure derivable before the swap's realized output exists).
  End state reads "at least X USDC at your address"; any slippage surplus above the minimum stays
  as ckUSDC in the wallet — the copy says exactly that. (Signing the expected-gross instead would
  let a normal slippage shortfall make the minter refuse — a designed dead-end; the floor never
  can, because a lower realized output refuses the SWAP atomically first.)

## 6. ckETH-gas preflight (fail-closed BEFORE any signature)

The minter burns ckETH for gas; a wallet with no ckETH cannot finish the route. Before the
confirm is offered, the intent form states the requirement: the min ckETH needed (live gas quote
+ the gas approve fee, from the minter's own numbers) and the wallet's ckETH balance. A KNOWN
zero/insufficient balance blocks the confirm with honest copy naming the requirement and the
amount (how to acquire the ckETH slice — e.g. converting a slice via the ICP↔ckETH venue — is
future work; today's copy says so). An unknown (unmeasured) balance shows the requirement without
blocking (the existing fail-open-on-unknown rule — a balance nobody measured is not a zero).

## 7. UX shape (ConvertMode)

- **Destinations:** from an asset, the destination list = the direct venue pair (today's
  behavior, the standing default — existing flows byte-identical) plus every composable route.
  The route is an explicit user selection, not a default.
- **No route chooser:** for a destination with exactly ONE route (Route A today) the screen
  SAYS there is one route (honesty line); when several routes reach one destination, the V5
  no-preselection venue-chooser rules apply per route (venue rows in registry order, never
  ranked, nothing preselected).
- **In flight:** a leg-by-leg list (each leg: label, its own fee, `pending | sent | confirmed |
  failed`) — the per-leg state IS the progress UI, no aggregate spinner fiction.
- **Terminal:** `done` names the net amount at the destination, the destination address, the
  per-leg refs (swap payout row + minter block index); `failed_leg` per §4; `stuck` per today.

## 8. Recovery (convertResume — unchanged rules, widened record)

Resume drives the record from the FIRST incomplete leg; confirmed legs are never re-signed,
never re-submitted (the plan state is the resume cursor — a `confirmed` leg's bytes are spent
history). `pending_withdrawal` re-arms the hop-ledger watch. `stuck` keeps the slow watch; its
probe for a planned record resolves a seen hop payout to `failed_leg` (dead envelopes) instead
of `done` (a seen ckUSDC row is NOT route completion). Acknowledge semantics unchanged.

## 9. Non-goals (wave 1)

Route B/C (CCTP v2, Jupiter/Solana legs — wave 3), buying the ckETH gas slice inside the
intent (ICP↔ckETH gas pre-conversion — future work), a route CHOOSER (needs a second route to
choose between), native-ETH burn routes (`withdraw_eth` leg set), per-leg manual re-signing
(the intent is one confirm), any dpay fee, any change to the payment flow.

## 10. Cross-rail widening (wave 3, 2026-09-16 — Routes B/C shipped)

Route A's record/executor/UI carry two more destinations, composed from the same registries
(`multihopRoutesFrom` now walks them; `docs/specs/2026-09-14-swap-venue-feasibility.md` §B/C):

- **Route B — ICP → USDC(Solana)** = Route A + a `cctp_burn` leg. Route C — ICP → SOL =
  B + a `sol_swap` leg (Jupiter, the wave-3a venue verbatim). One route per destination pair
  today; the "one route" honesty line renders only when literally one route exists.

**New leg kinds (the plan tail, `canister: ''` — no IC canister):**

- `cctp_burn` — the EXTERNAL-signature leg. dpay holds no EVM key and signs nothing: it BUILDS
  the two exact Ethereum transactions (`TokenMessengerV2.depositForBurnWithHook` on
  `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`, preceded by the canonical-USDC approve) and
  hands them to the user's own wallet (see the signing boundary below). Plan states still
  apply: `pending` at prepare, `sent` when the burn tx hash is attached, `confirmed` when the
  Circle mint is corroborated on-chain at the ATA.
- `sol_swap` — the final device-signed Jupiter leg (the wave-3a `SolanaSwapLeg` verbatim:
  fresh quote on the minted amount, beneficiary-verified before signature, identical bytes on
  retry).

**CCTP v2 shape (live-verified 2026-09-15, cited in `app/cctp.ts`):** burn amount = Route A's
swap floor (minOut); mint recipient = the user's USDC ATA (the Forwarding Service's extended
hookData carries the OWNER so Circle creates the ATA — no pre-existing ATA required);
destination domain Solana = 5; finality FAST = 1000; maxFee = Circle's live published fee
(`iris-api` burn/fees, med forwardFee) + 20% buffer, fetched BEFORE any leg is signed
(fee unreachable → nothing signed, same fail-closed rule as route gas).

**The signing boundary — explicit handoff v1:** dpay renders the exact txs (to, calldata,
value 0, copyable) and polls Circle's own status feed by burn tx hash. The user signs in their
own Ethereum wallet (the same address as `destAddress` — the picker warns it must be an
address they control). dpay attaches the returned burn tx hash, then auto-continues when the
attestation completes AND the USDC credit is verified at the ATA via the SOL rail — a stalled
attestation parks pending with Circle's own link, never a false failure.
**Upgrade note (WalletConnect in-session signing):** the handoff is deliberately the floor
design. `app/walletconnect.ts` is the payment-critical onramp surface (additive-only rule) and
is runtime-unreachable in jest/e2e (stubbed module), so an in-session WC path could not be
exercised by any offline gate; when WC dapp-side sessions are added they must remain a
separate, additive surface with its own device gates.

**New record fields:** `crossRail: {kind: 'cctp'|'cctp_sol', solAddress, mintRecipientAta,
maxFeeSubunits, mintFloorSubunits, burnTxHash?, forwardTxHash?, mintSubunits?, solVenueId?,
solExpectedLamports?}`; new steps `awaiting_external` (user-paced — no driver advances it),
`crossing`, `sol_ready`; new failureCode `external_declined` (dead-end copy names the funds:
USDC at the user's OWN Ethereum address, exit = any wallet send or re-run later). Hydration
pins cross-rail records to their own step vocabulary and the plan-tail shape
(`legs + cctp_burn [+ sol_swap]`); `solanaLeg` coexists ONLY on a cross-rail record.

**Fee census honesty:** EVM gas for the burn is the USER's wallet's own ETH — an external
line dpay cannot pay or quote exactly; Circle's fee is rendered as Circle's own number with
the derived mint floor ("at least X arrives at your Solana address"); Jupiter/SOL fees per
wave-3a. Slippage/floors per §5.

**Wave-3 e2e:** flow 186 drives the whole chain offline (`e2e/harness/cctp.mjs` fakes the
Circle fees + status feed keyed by burn tx hash; a `__DPAY_TEST_EVM_SIGN` window seam stands
in for the user's wallet) including the mid-CCTP reload (engine resumes from the mint watch,
IC legs never re-signed) and the stalled-attestation dead-end.

**Non-goals (updated):** WalletConnect in-session signing (above), Route B/C on the CeFi
provider rail, buying the ckETH gas slice in-intent, per-leg manual re-sign, any dpay fee.
