# 2026-09-08 — Conversion PoC hardening: direction from the venue, one decoder, no dead surface

Continues [`2026-09-07-delegated-conversion-spec.md`](2026-09-07-delegated-conversion-spec.md).
That spec's §1 said: *"Token0/token1 order and `zeroForToken0` come from the pool's own metadata —
read them, never assume."* The build assumed. This plan closes that and the review findings that
came with it.

## Evidence — measured 2026-09-08, mainnet, read-only queries

The one-live-probe duty OPEN_ISSUES item 2 recorded is **discharged**, and it found worse than it
was looking for.

- **The `ok`/`err` re-casing is CORRECT.** The live pool's reply type table is byte-identical to
  `SWAP_RESULT_TABLE`; `dpay_icp::icrc::decode_swap_result` run on the live bytes yields
  `Ok(41194138)` and `Err(InternalError("preswap \"Illegal amountIn\""))`. Our `SwapArgs` encoding
  is accepted verbatim (our golden arg bytes and a dfx-encoded arg return the same value).
- **The pool's pair order is the REVERSE of what the code pins.** Live `metadata`:
  `token0 = ly36x-… (VCHF)`, `token1 = ryjl3-… (ICP)`, `fee = 3000`, key
  `ly36x…_ryjl3…_3000`. The code pinned `token0 = ICP`.
- **Live production consequence, measured against `https://dpay.kalaj.org/api/v1/swap_quote`:**
  ICP→VCHF returns `41194138` (`zero_for_one: true`) — that is the VCHF→ICP price. The true rate
  is 1 ICP = 2.41297899 VCHF; the route reports 0.41194138. **Wrong by ~5.9×, against the user.**
  Cross-checks: the round-trip product 0.994006 vs `(1−0.003)² = 0.994009`; and the spec's own
  2026-09-05 float trade (0.0102 ICP → 0.02119881 VCHF ⇒ ≈2.08 VCHF/ICP) agrees with 2.41 and
  contradicts 0.41.
- **Why the offline loop could not see it:** the fake-IC pool stub is seeded from the same reversed
  pin, so fake and pin agreed with each other and neither agreed with the venue.

## The rule this violated

An assumed remote fact, pinned as a constant, with the test fake seeded from the same assumption,
is a closed loop that proves only its own consistency. Where a remote system publishes the fact,
**production reads it**; a pinned copy exists only as MEASURED test-fixture truth with a live drift
alarm on top.

## Work streams

### A — direction comes from the pool (P0, money-critical)

1. `crates/dpay-relay/src/catalog.rs` — delete `SwapVenue`, `ICP_VCHF_VENUE`, `venue_for_pool`.
   Replace with `is_known_swap_pool(pool) -> bool` (the allowlist; a pool id, not a pair claim).
2. `crates/dpay-relay/src/agent_ledger.rs` — add `swap_pool_metadata(pool)` to the `Ledger` trait's
   read surface: a candid mirror of the live `.did` `PoolMetadata`, queried anonymously, cached
   with a TTL alongside the existing `deposit_info` cache pattern. Returns
   `{token0_ledger, token1_ledger, fee_millionths}`.
3. `crates/dpay-relay/src/app.rs` — `swap_quote_direction` becomes pair validation against the
   pool's OWN metadata in both builds: `zero_for_one = token_in == token0`, `unsupported_pair`
   when `{token_in, token_out} != {token0, token1}`, `unknown_pool` off the allowlist.
   `SwapQuoteBody` gains `fee_millionths` — the venue's own tier, echoed, not claimed.
4. `crates/dpay-relay/src/ic_gateway.rs` — reseed the stub pool to the MEASURED live order
   (`token0 = VCHF`, `token1 = ICP`), reserves following their own token so quoted amounts are
   unchanged and only the direction flag flips.
5. `dfx/catalog_truth.json` — new `swap_venue` block (`pool`, `token0_ledger`, `token1_ledger`,
   `fee_millionths`), MEASURED 2026-09-08, with the two existing offline drift-alarm halves (Rust
   `#[cfg(test)]`, jest) plus a **mainnet tripwire recipe** in the shape of `just ic-index-probe` /
   `just ocp-ledger-probe`, asserting the LIVE pool's own metadata still matches that block.
   (`just test-live` is PocketIC, not mainnet — it cannot see a venue fact.)
6. `app/config/convert.ts` — `CONVERT_VENUE_LEDGERS` (ordered) → an unordered pair;
   `resolveConvertDirection` returns `{otherLedger}` only. Delete `CONVERT_POOL_FEE_TIER_LABEL`
   (the relay now echoes the venue's tier). The app never holds an order it could get wrong.

**RED first:** a `test-live` assertion that the route's `zero_for_one` equals
`token_in == live metadata.token0` fails at HEAD; the offline relay test that the stub's seeded
order equals `catalog_truth.json` fails at HEAD.

### B — one decoder, one encoder (DRY hard rule)

`app/convert.ts` hand-rolls a candid decode of the pool reply (`SWAP_RESULT_TABLE_HEX` +
`decodeSwapResult` + `readUleb`) that duplicates `dpay_icp::icrc::decode_swap_result`, and
`e2e/web/dpay-core-wasm.ts` hand-rolls TS twins of `icp_deposit_and_swap_arg` / `icp_swap_min_out`
because `crates/dpay-wasm` never exported them — so every e2e conversion flow signs bytes the
compiled core did not produce. Fix: export the three from wasm/FFI, delete both twins and
`app/__tests__/convert-core-twin.test.ts`, extend the export census in
`scripts/check-wasm-core.mjs`. Then delete the genuinely dead codec surface left in
`crates/dpay-icp/src/icrc.rs` (`swap_arg`, `decode_allowance_record`, `encode_pool_metadata` and
their tables) and the three unreachable fake-gateway query arms.

### C — the Convert screen itself, as a user actually sees it

Driven on the LIVE production build (`https://dpay.kalaj.org/wallet`, headless Chrome, real
onboarding → CHF → ICP → Convert, 1 ICP entered) on 2026-09-08. Everything below is a
screenshot-confirmed defect on the money screen, not a code reading:

1. **The unit is printed twice on every money line** — "Balance: 0 ICP ICP", "Input fee:
   0.00010000 ICP ICP", "Output fee: 0.00010000 VCHF VCHF", "Minimum you'll receive: 0.40782196
   VCHF VCHF", "End state: 0.41184138 VCHF VCHF". The formatter already appends the symbol and the
   i18n template appends it again (`app/i18n/domains/en/convert.ts` `balanceLine`/`inputFeeLine`/
   `outputFeeLine` and their call sites). Exactly ONE of the two owns the symbol — fix all four
   locales and every call site, and pin it with a test.
2. **"Price impact: —" never resolves.** Still an em-dash after 10 s on a live quote. A permanent
   placeholder is a bug; either the reference quote is never fetched or its result is dropped.
3. **"Re-quote and confirm" is enabled at zero balance** (`aria-disabled` is null) — a confirm
   that can only fail. Fail closed and say what to do instead (receive ICP first, with the route
   the fund gate already knows how to show).
4. **The slippage chips have no label** — three naked percentages float between "Price impact" and
   "Minimum you'll receive". The `slippageLabel` key exists in all four locales and is rendered
   nowhere.
5. **No hierarchy on a money decision screen.** The rate — the one number the decision turns on —
   renders at the same size and weight as the fee lines, inside an undifferentiated grey block,
   and the amount the user will RECEIVE has no headline at all. The pool principal wraps
   mid-token. This is the screen a user signs from; it should read as one number, then the terms.

### C2 — the honest error path, the dead keys, the a11y shape

`quoteUnavailable` currently renders `"Quote unavailable (404)."` — a state that only describes
itself, against the founder's 2026-08-29 rule. Give it an actionable body. Delete the unrendered
`slippageLabel` key and the dead `ConvertLegs.zeroForOne` field; parameterise the `counterparty`
copy so the pool principal is not baked into four translations; give `btn-home-convert` its own
hint and a `disabled` accessibility state; fix the stale module comment; add the missing
`process.exit(1)` to every standalone e2e flow that lacks it.

### D — the surfaces the same drive exposed outside Convert

Same live drive, same build:

- **A brand-new production wallet is created with ∂0.00 DEMO** — the relay's
  `/api/v1/capabilities` reports `demo_faucet: false` while `POST /api/v1/faucet` returns
  `200 {"balance":"10000"}`. The capability lies, and onboarding believes it. Owned by the
  capabilities work, not by this plan.
- **The trip strip shows `fundsReady` FILLED on a wallet holding nothing** — a readiness claim
  contradicted by the balance on the same screen.
- **The currency chooser's EUR row is glyphed `◎`** (the Solana mark) where CHF shows `V` and USD
  shows `$`. The row is the currency the user thinks in, so the glyph should be the currency's
  (`CHF` / `$` / `€`), never the preferred rail's token mark.

## Status

Streams A, B, C, C2, D: NOT STARTED at the time of writing. Each is closed by striking it here
with its commit when it lands — no other status copy exists.
