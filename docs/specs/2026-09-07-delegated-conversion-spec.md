# 2026-09-07 — Delegated conversion PoC: ICPSwap ICP↔VCHF, the user's device signs, dpay stays a screen

Founder direction, 2026-09-07, verbatim intent:

> "I do NOT want to be an exchange, but I DO WANT to have full integration with existing DEFI
> and/or CEFI exchanges, and be able to swap quickly and easily. Ideally, in a hands-off fashion.
> But delegating, not doing ourselves! … no custody, swap from the app, probably swapping from
> the recipient side (merchant) makes more sense since they are online, and they can decide if
> they accept a currency or not … align with precedents … Let's do NOW what makes sense, and then
> if we have a PoC that should be compliant, we can ask for a confirmation from the officials."

This spec is the ICPSwap execution/recovery spec `docs/VCHF_ICP_ANALYSIS.md` called for after the
direct assets shipped. It is deliberately written to the `docs/REGULATORY.md` §4 checklist and the
§3.1 precedent map (Coinbase Wallet = the shape that won; MetaMask's momentary funds-hold and
"best" labeling = what got charged; Atomic Wallet's "only an interface" = a defence that failed).

## 0. The frame — every line of code answers to this

1. **dpay is never a party to the trade.** No dpay-controlled address, canister, key, or relay is
   in the funds path, even momentarily. The user's own account; the pool pulls via the user's own
   ICRC-2 approval; output lands at the user's own principal.
2. **The user's device signs everything** that moves funds (`icrc2_approve` on the input ledger,
   the pool's `depositFromAndSwap`) — the exact same app-signed `/api/v2` rail payments use. dpay
   cannot release, stop, or reverse anything.
3. **The venue's own quote, verbatim, attributed, timestamped.** dpay never computes, blends,
   ranks, or labels a rate "best". `amountOutMinimum` = the user's chosen slippage tolerance
   applied to the venue's quote (execution protection, disclosed on screen — not a dpay rate).
4. **One venue per pair.** The PoC integrates exactly one pool per direction, so no routing
   surface exists. When a second venue ever arrives, the user picks — never dpay.
5. **No dpay cut.** The fee section states dpay is paid nothing, explicitly.
6. **Recipient-side, not mid-payment.** The payment flow NEVER offers, suggests, or implies
   conversion; a request for asset X settles X (`VCHF_ICP_ANALYSIS.md`: automatic conversion
   forbidden). Convert is a standalone wallet action on the user's own settled balance — the
   merchant narrative (convert proceeds to the home asset) is positioning, not a different code
   path. Every asset gets the same Convert entry point (uniform-IA hard rule, `CLAUDE.md`); where
   no venue exists it fails closed with an honest reason + what exists today.
7. **No leverage, no auto-convert, no pre-authorized recurring delegation.** "Hands-off" = one
   tap, no address wrangling, quote fetched for you — NOT unattended automation. Auto-rules are
   out until officials/counsel answer (`docs/REGULATORY.md` §7).

## 1. PoC scope

- **Pair:** ICP ↔ VCHF, both directions, ICPSwap V3 pool `65mrh-fqaaa-aaaar-qapoa-cai`
  (factory `4mmnk-kiaaa-aaaag-qbllq-cai`, fee tier 3000). Ledgers: ICP
  `ryjl3-tyaaa-aaaaa-aaaba-cai`, VCHF `ly36x-wiaaa-aaaai-aqj7q-cai` (both 8dec, already in the
  catalog, ids 8 and 7).
- **Evidence this pool works from a raw device key:** 2026-09-05 float operation
  (`docs/AGENT-FUNDS.md` spend log) — `icrc2_approve` 1,020,000 e8s, 10-min expiry, spender =
  the pool; `depositFromAndSwap` returned `0.02119881 VCHF`, exactly the pre-flight quote,
  `amountOutMinimum` 1,800,000.
- **Explicitly refused in the PoC UI:** the direct VCHF↔ckUSDC pool `hx7nb-diaaa-aaaar-qbxsa-cai`
  — measured saturated (tradeable depth ≈ CHF 315, `docs/specs/2026-09-04-currency-first-wallet-plan.md`);
  ckUSDC's Convert fail-closed copy names the two-hop reality honestly instead of offering it
  (multi-hop is a follow-up, not PoC).
- **Offline reference for every call shape** (do not re-derive):
  `third_party/oisy-wallet/src/declarations/icp_swap_pool/icp_swap_pool.did` (+ `.did.d.ts`,
  factory declarations) and `third_party/oisy-wallet/src/frontend/src/lib/services/icp-swap.services.ts`
  + `swap.services.ts` (+ their specs). The pool's `quote` is a query; `depositFromAndSwap` is an
  update. Token0/token1 order and `zeroForToken0` come from the pool's own metadata — read them,
  never assume.

## 2. Architecture

- **Quote (read-only, relay-proxied):** `GET /api/v1/swap_quote?pool=<id>&token_in=<ledger>&token_out=<ledger>&amount_in=<e8s>`
  on the relay → the relay's agent queries the pool's own `quote` and returns it **verbatim**
  plus `fetched_at`. The relay never computes a rate — it is a read proxy, the same class as the
  balance fan-out. (Keeps the app's `/api/v2` surface = signed updates only, and gives e2e one
  stub point.) App module: `app/convert.ts` (root production module, like `wallet.ts`).
- **Arg building in the Rust core** (money-critical ⇒ `dpay-core`, the code the tests ship):
  - `icrc2_approve` DIDL encoder (from_subaccount, spender = pool Account, exact amount + fee,
    `expected_allowance`, `expires_at`, memo, created_at_time) — mirror of the existing
    `icp_transfer_arg` pattern; proptests for encoding (golden-pin against `@dfinity/candid`
    like the legacy-transfer codec was).
  - `depositFromAndSwap` arg encoder (ICPSwap `SwapArgs` — exact shape from the `.did`).
  - Exposed through dpay-ffi + Kotlin (`just ffi` must stay green).
- **Venue consts live app-side** in `app/config/` for the PoC (pool, factory, ledgers, fee tier);
  migrating them into the catalog rows (`catalog.rs` + `catalog_truth.json`) is a follow-up
  BEFORE any live ship, not part of this build.

## 3. Approve bounds (least-authority, matches the governance posture)

- Approval = **exact swap amount + approve fee**, `expires_at` = now + 10 min,
  `expected_allowance` present. No open-ended allowance, ever.
- A stuck-but-unspent approval expires worthless in ≤10 min — the UI shows that countdown in the
  failure state. An explicit `icrc2_approve(0)` revoke tx is a follow-up only if recovery states
  show it is needed.

## 4. Execution & recovery state machine (the `VCHF_ICP_ANALYSIS.md` warning, made concrete)

The pool's initial `#ok` contains **gross** output; the wallet receives gross minus the output
ledger fee; a failed asynchronous withdrawal/refund can leave funds in the pool's unused-balance
accounting. So `#ok` ≠ settled. Persisted per swap (AsyncStorage `dpay.convert.v1`, one record
per swap id):

```
quote → confirming → approving → approved → swapping → settling
                                                    ├→ done{out_amount_net, out_tx}
                                                    ├→ pending_withdrawal   (pool #ok, output not seen yet)
                                                    ├→ failed_refunded      (refunded transfer seen)
                                                    └→ stuck                (honest unknown — instructions, not a spinner)
```

- **Identical-envelope retry discipline:** retries re-submit the SAME signed bytes — the IC
  admits one envelope per request id once (the same dedup that makes replay-safe payments work).
  Never rebuild args mid-swap.
- Settlement detection rides the existing ledger-watch/balance-delta machinery (an incoming
  transfer on the output ledger at the user's principal) — `pending_withdrawal` resolves when the
  delta lands; it never fabricates completion from the `#ok` alone.
- Every non-`done` state is a screen with useful instructions (founder hard rule): what was
  signed, what is pending where, when the approval expires, and what the user can do next.

## 5. The screen — transparency checklist as rendered lines (each one e2e-asserted)

Before anything is signed, on one surface, no tap to reveal (`positioning.md` checklist, adapted
honestly for a DeFi venue — there is NO licensed provider to name, and the screen says so):

- **Counterparty:** "Executed by the ICPSwap pool `65mrh-…-cai` — an autonomous on-chain contract,
  not a licensed provider and not dpay. Your phone signs; the pool pulls exactly the approved
  amount."
- **Rate:** the pool's own quote, as a number the user can compare, with source + the instant it
  was fetched ("Quote from ICPSwap, fetched 14:32:05"). Auto-refresh when stale (>30 s) and
  re-quote at confirm.
- **Every fee separately:** pool fee tier (0.3%), input-ledger fee, output-ledger fee, and
  "dpay charges nothing and is paid nothing for this".
- **Price impact** from the quote, warned above 5%.
- **Minimum you'll receive** (the user's slippage choice: 0.5% / 1% / 3%, default 1%) and what
  happens on refusal (transaction fails, funds stay, approval expires).
- **End state:** exact expected destination amount net of fees.
- **Failure state:** which asset the user is left holding in each branch, and that dpay cannot
  reverse it.

i18n: every string through `M.*` in all four locales. `styles.ts` gains any new styles in the
one `StyleSheet.create` block.

## 6. Tests & gates

- **dpay-core:** proptests for both encoders; conservation-style checks (approve amount vs swap
  amountIn never diverge; min-out ≤ quote).
- **relay:** unit tests for the quote route (verbatim passthrough + `fetched_at`; refuses
  unknown pools).
- **test-helpers fake-IC:** a stub pool canister (quote with a deterministic curve + configurable
  impact/fee, `depositFromAndSwap` pulling the approved input and queueing the output transfer,
  with a knob to force the withdrawal-failure path) + `icrc2_approve`/`icrc2_allowance` on the
  fake ledgers.
- **jest:** pure derivations (min-out, net amounts, state transitions), persisted-record
  round-trip, fail-closed copy for venue-less assets.
- **e2e flows** (FLOWS.md is generated — add flows, regen): (a) happy path Balances → ICP →
  Convert → every itemised line asserted → confirm → done row + Ledger entry; (b)
  pending_withdrawal honest state then resolution; (c) venue-less asset fail-closed copy;
  (d) stale-quote refresh. Screenshot every state.
- **Gates:** `just ffi`, `just verify` (typecheck + parity guards included), full jest, `just app`
  (FFI surface changed ⇒ device gate; assert `DPAY_SELFCHECK PASS`). `just ondevice` if the
  emulator session allows. Prod reconcile note: the quote route is offline-only until the founder
  ships the relay (`just up`) — do NOT claim live.
- **CODEBASE_ANALYSIS.md:** add the new surface (convert rail: user-signed approve/swap, recovery
  states, quote proxy) in the same change.

## 7. Non-goals (do not build)

CeFi venue integration (DFX swap etc. — user-direct handoff later), Solana/Jupiter, multi-hop,
auto-convert rules, per-pair venue choice UI, any dpay fee, catalog migration, revoke tx,
payer-side mid-payment conversion, debit of the payment review flow in any way.

## 8. After the PoC (founder-run, recorded here so it is not lost)

The founder carries the built screen + this spec to the officials/counsel ask
(`docs/REGULATORY.md` §7 — Q1 with a real artifact instead of a hypothetical; the recipient-side
framing is the strongest Coinbase-Wallet-shape pattern in the record; §8 limits still apply).
Nothing in the product copy may describe conversion in the present tense until those answers and
the founder's live-ship decision land (`positioning.md` roadmap-verb rule).
