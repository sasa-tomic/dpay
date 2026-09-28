# Goal: 2-tap swaps between ANY two supported currencies

Filed 2026-09-28, right after the EVM rail landed and the D31 mainnet ZCHF round trip proved
it live. This is the standing goal for the next session.

## State (what exists today)

- The two-tap convert surface is LIVE: `app/convert/` (plan / quotes / prepare / execute /
  executeCrossRail / executeSolana / cctp / records / types / providerStatus) +
  `ConvertIntentSheet` (pick source, pick destination, confirm). Flow 213 pins the composed
  path; `convertResume` carries interrupted orders.
- Venues are hand-registered, one pair list at a time:
  - jupiter: SOL-rail natives/stables (SOL, USDC, EURC) — EURC→SOL, EURC→USDC live-proven.
  - sideshift: ICP↔EURC and ICP→native-ETH (adapter-owned synthetic pair, flow 223) —
    live in PROD with the partner key; D31 moved real value on all three in-app.
  - trocador: founder-pair-locked to ICP↔SOL (test-tripwired; do not unlock silently).
  - CCTP Route-B: ckUSDC↔USDC cross-rail.
- The EVM rail is live end to end: ZCHF catalog rows (Arbitrum One + Ethereum), PROD EVM RPC
  pipe on both chains, and `scripts/evm-mainnet-zchf-buy.mjs` — a working, D31-hardened
  Uniswap V3 buy (QuoterV2 + SwapRouter02 exactOutputSingle, wrap+approve, nonce sequencing).

## The gap

A user can only swap the pairs somebody typed in. ZCHF→anything, anything→ZCHF, ckBTC→EURC,
ICP→USDC — none exist unless a venue adapter happens to carry them, and EVM-token
destinations have no adapter at all. The 2-tap UX is ready; the breadth is not.

## Goal

Pick any source and any destination among supported currencies and get a quote in two taps,
with automatic venue selection and an automatic one-hop route through a hub asset when no
direct pair exists.

## Work items

1. **Derive pairs, don't register them.** Build the (source, destination) candidate set from
   the catalog (IC, Solana, and EVM sections + native assets: ICP, ckBTC, ckETH, native
   SOL/ETH) crossed with a per-venue capability table: which (source rail class, destination
   rail class) a venue serves and its per-asset ids. The convert matrix becomes generated
   output, checked by the existing drift alarm (`convert-matrix --check`), not a hand list.
2. **Uniswap V3 adapter on the EVM rail (ZCHF first).** Quote via QuoterV2, swap via
   SwapRouter02, run through the relay's `/api/v1/evm/rpc` pipe. The seed is
   `scripts/evm-mainnet-zchf-buy.mjs` (five bugs found and fixed during D31 — reuse it, do
   not rewrite it). App-side it must ride the same gas-honesty gate and nonce handling as
   `EvmWithdrawSheet`, and the device holds the key as always: dpay never custodies, never
   pays gas. Then generalize the adapter to any EVM-token destination (chain_id + contract
   from the catalog row).
3. **Hub fallback.** No direct venue pair → auto-compose A→hub→B (hubs: USDC, USDT, ETH,
   SOL, ICP) on top of `executeCrossRail`. Both legs quoted before commit; the fee surface
   shows the combined cost, never a surprise mid-flight.
4. **Honest unavailability.** Pairs with no venue and no hub path stay visible but refused
   with the reason (no venue / no liquidity), the same way catalog rows already carry honest
   `Unavailable` ramps.
5. **Gates.** Convert-matrix regen check green; jest pins per adapter (anvil golden-vector
   quotes for the Uniswap leg); flow tests for a composed A→hub→B path; i18n en/de/es/fr.
   D31 discipline carries over: each new adapter gets ONE live, funds-ledgered trip through
   the real app before any "supported" claim.

## Non-goals

No custody change (dpay holds no EVM key, never pays or quotes gas). No new rails. No order
book, no leverage, no limit orders. The trocador pair lock stays unless the founder unlocks it.
