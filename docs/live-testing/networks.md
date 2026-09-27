# Testnet vs mainnet: per rail and venue

Dates gate the free-path search: if a row's last-checked date is less than 24h old, skip the
search; otherwise at most 10 minutes, then record the outcome here.

| Rail / venue | Free test path? | Cheapest live probe | Last checked | Notes |
|---|---|---|---|---|
| ICP ledger | none useful | ICP transfer (fee 0.0001 ICP) | 2026-09-26 | IC testnets exist but carry no ICRC venue liquidity; dpay's catalog is mainnet-only. Design-time knowledge, full search not yet run. |
| VCHF (ICRC) | none | swap ICP to VCHF on ICPSwap, smallest amount | 2026-09-27 | Mainnet-only token, no faucet. LIVE-PROVEN 2026-09-27: 0.01 ICP -> 0.02562143 VCHF via the app (see dead-end log for the trip record). |
| ckUSDC / ckBTC / ckETH | none | smallest ICPSwap swap | 2026-09-26 | No free path in the dpay catalog. Design-time knowledge. |
| ICPSwap (IC DEX) | none | smallest pool swap (icrc2 approve + swap) | 2026-09-27 | Mainnet-only DEX. LIVE-PROVEN 2026-09-27: pool 65mrh-…-cai executed icrc2_approve + depositFromAndSwap from the app; quoted 2.57 VCHF/ICP verbatim; settled in seconds; fees exactly the two 0.0001 ICP census lines. |
| Jupiter (Solana) | none | smallest quote (free, read-only) through the relay proxy; smallest swap (Solana tx fee 0.000005 SOL) | 2026-09-27 | Quotes live + verbatim through /api/v1/jupiter/quote. Execution was BLOCKED by venue drift (asLegacyTransaction 400, see dead-end log) — RESOLVED by uix 145ec40; LIVE-PROVEN 2026-09-27: 0.5 EURC -> 0.569229 USDC through jupiter-usdc-eurc, one broadcast, fee exactly 0.000005 SOL, no priority fee. |
| Solana devnet | partial | SOL faucet; devnet USDC via Circle faucet | 2026-09-26 | EURC is not issued on devnet; Jupiter devnet is limited; dpay venues do not run devnet. Design-time knowledge. |
| EURC (Solana) | none | receive-side exercises are free with an existing EURC balance (float holds some) | 2026-09-27 | Circle issues EURC mainnet-only. Float rail measured 9.198416 EURC 2026-09-27; app derivation re-proven (in-app derived rail shows the exact float balances). |
| Trocador (CeFi) | none | smallest supported order (venue minimum, roughly $5-20) | 2026-09-26 | Mainnet-only; partner API terms (poll floor) apply; relay holds no DPAY_TROCADOR_API_KEY yet (routes 503). Design-time knowledge. |
| SideShift (CeFi) | none | smallest supported order (venue minimum moves with rate: 2026-09-27 EURC→ICP 8.787025 EURC, ICP→EURC ~3.109 ICP) | 2026-09-27 | Mainnet-only; exact-amount deposit windows. Prod proxy LIVE with the deployed (docs-example) credentials: quotes AND order creation pass auth (order-creation 201 verified with one unfunded probe order, expired by design). LIVE-PROVEN 2026-09-27: ICP→EURC via the app — order 11:49:45Z, exact 4.47 ICP deposit (ICP block 38641763), payout 12.422931 EURC = the verbatim quote to the last digit (slot 450989680). EURC→ICP: venue min exceeds the float (8.698); that leg's live proof stands from 2026-09-22 (shift d61b2eec). |

## Practical routes with the current float (2026-09-27)

- IC side (2026-09-27, post-flagship): ICP 0.5058 + VCHF 0.0302 + ckETH dust. Tiny IC probes
  still possible; anything CeFi- or Ethereum-sized needs a top-up (above the <=CHF 2 line).
- Solana app rail (2026-09-27, post-flagship): EURC 21.121347 + USDC 0.829 + SOL 0.0017. Both
  directions of EURC<->USDC are now live-proven through Jupiter at the smallest sensible size;
  SOL-gas headroom is ~0.0017 (roughly 300 more swaps at 5000 lamports each).
- Composed VCHF->EURC (flagship): LIVE-PROVEN 2026-09-27 after the founder credential deploy.
  Leg 1 two-tap 4.5 ICP -> 11.69465451 VCHF via icpswap (quote 11.69475451 verbatim, minus the
  0.0001 output fee); the CeFi completion ran through the direct sideshift-eurc surface
  (in-app order -> exact deposit -> payout watch) after the driver's browser context died
  mid-flow: 12.422931 EURC = the verbatim quote to the last digit, EURC float 8.698 -> 21.121,
  reconcile CLEAN. Full evidence in funds/ledger.jsonl rows 156-164.

## Dead-end log (do not re-search before last-checked + 24h)

- **2026-09-27 — the convert settle probe parks a LIVE record on `stuck` too early under prod
  latency (finding, filed in OPEN_ISSUES).** The flagship leg-1 ICPSwap swap settled on-chain
  at ~+11 s (ICP block 38641313 -> VCHF payout 82188) while the app had already parked the
  record on `stuck` at ~+9 s. The honest-unknown design held (no false done, correct "do not
  start a second swap" guidance, funds never at risk), but a real boundary round trip under
  host contention beats the probe budget. Related harness note: conversion records are
  context-local, so a dead browser mid-flow loses the record (funds survive in the wallet; an
  unfunded venue order expires harmlessly). The stuck -> done reopen flip is still unverified
  on web.
- **2026-09-27 — Jupiter lite-api swap build (Solana execution leg): RESOLVED same day.**
  Found: lite-api quotes now carry `"transactionVersion": 0`, and the app's build body
  (`asLegacyTransaction: true`) got a deterministic `400 NOT_SUPPORTED` — every Jupiter
  execution blocked; no funds ever moved (verified on-chain per attempt). Resolution: uix
  commit **145ec40** omits the param when the quote self-describes its version (build-refusal
  copy also made honest, 4 locales); the fail-closed shape check stays in
  `verifyVenueSwapTxBeneficiaries`. Re-verified live the same session: the fixed build ran the
  real two-tap convert **0.5 EURC -> 0.569229 USDC** via jupiter-usdc-eurc (Whirlpool
  `ArisQNcb…`), one broadcast, tx `sol:394mcX6X…MvGwwDv`, fee exactly 0.000005 SOL, chain
  deltas == done panel == ledger. Entry kept as the resolved-dead-end record; no re-search
  needed.
- (No free-testnet search was due: every row's last-checked was same-day/next-day and the
  affected venues are mainnet-only per the table.)
