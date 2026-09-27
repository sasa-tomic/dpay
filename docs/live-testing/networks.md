# Testnet vs mainnet: per rail and venue

Dates gate the free-path search: if a row's last-checked date is less than 24h old, skip the
search; otherwise at most 10 minutes, then record the outcome here.

| Rail / venue | Free test path? | Cheapest live probe | Last checked | Notes |
|---|---|---|---|---|
| ICP ledger | none useful | ICP transfer (fee 0.0001 ICP) | 2026-09-26 | IC testnets exist but carry no ICRC venue liquidity; dpay's catalog is mainnet-only. Design-time knowledge, full search not yet run. |
| VCHF (ICRC) | none | swap ICP to VCHF on ICPSwap, smallest amount | 2026-09-27 | Mainnet-only token, no faucet. LIVE-PROVEN 2026-09-27: 0.01 ICP -> 0.02562143 VCHF via the app (see dead-end log for the trip record). |
| ckUSDC / ckBTC / ckETH | none | smallest ICPSwap swap | 2026-09-26 | No free path in the dpay catalog. Design-time knowledge. |
| ICPSwap (IC DEX) | none | smallest pool swap (icrc2 approve + swap) | 2026-09-27 | Mainnet-only DEX. LIVE-PROVEN 2026-09-27: pool 65mrh-…-cai executed icrc2_approve + depositFromAndSwap from the app; quoted 2.57 VCHF/ICP verbatim; settled in seconds; fees exactly the two 0.0001 ICP census lines. |
| Jupiter (Solana) | none | smallest quote (free, read-only) through the relay proxy | 2026-09-27 | Quotes LIVE and healthy through /api/v1/jupiter/quote (EURC->USDC 0.5 -> 0.5692, verbatim). Swap BUILD BROKEN 2026-09-27: lite-api now 400s the app's `asLegacyTransaction: true` ("asLegacyTransaction cannot be used with quoteResponse.transactionVersion", NOT_SUPPORTED) — see dead-end log; execution blocked until app fix. |
| Solana devnet | partial | SOL faucet; devnet USDC via Circle faucet | 2026-09-26 | EURC is not issued on devnet; Jupiter devnet is limited; dpay venues do not run devnet. Design-time knowledge. |
| EURC (Solana) | none | receive-side exercises are free with an existing EURC balance (float holds some) | 2026-09-27 | Circle issues EURC mainnet-only. Float rail measured 9.198416 EURC 2026-09-27; app derivation re-proven (in-app derived rail shows the exact float balances). |
| Trocador (CeFi) | none | smallest supported order (venue minimum, roughly $5-20) | 2026-09-26 | Mainnet-only; partner API terms (poll floor) apply; relay holds no DPAY_TROCADOR_API_KEY yet (routes 503). Design-time knowledge. |
| SideShift (CeFi) | none | smallest supported order | 2026-09-27 | Mainnet-only; exact-amount deposit windows. Prod relay holds NO partner credential — the app's 503 tripwire copy confirmed live 2026-09-27 ("SideShift is not set up on this relay yet… Nothing is wrong with your wallet."). Round trips need the founder key first. |

## Practical routes with the current float (2026-09-27)

- IC side (after the 2026-09-27 trip): ICP 0.005 + VCHF 0.0257 + ckETH dust. Tiny IC probes
  still possible; anything CeFi- or Ethereum-sized needs a top-up (above the <=CHF 2 line).
- Solana app rail: EURC 9.198 + USDC 0.259 + SOL 0.0017. EURC->USDC quotes exercise free;
  EXECUTION is blocked by the Jupiter build defect below until the app fix lands.
- Composed VCHF->EURC (flagship deposit-leg route): blocked on prod twice over — VCHF float is
  dust (CeFi minimums ~CHF 10-15) and the CeFi legs have no partner credential on prod (503
  tripwire). Route resolution + honest fail-closed states verified offline-only 2026-09-27.

## Dead-end log (do not re-search before last-checked + 24h)

- **2026-09-27 — Jupiter lite-api swap build (Solana execution leg): BROKEN by venue drift.**
  What happened: two in-app confirm attempts (0.5 EURC -> USDC via jupiter-usdc-eurc) never
  broadcast; the app failed closed with "Jupiter declined to quote this pair right now." after
  `POST /api/v1/jupiter/swap` returned 400. No funds ever moved (balances verified unchanged
  on-chain after every attempt; no retry of any transfer — fresh attempts only after on-chain
  all-clear). Root cause reproduced keylessly: lite-api quotes now carry
  `"transactionVersion": 0`, and any /swap build posting the app's exact body
  (`services/jupiter.ts fetchJupiterSwapTx`: `asLegacyTransaction: true`) answers
  `400 {"error":"asLegacyTransaction cannot be used with quoteResponse.transactionVersion",
  "errorCode":"NOT_SUPPORTED"}`. Dropping the param on the SAME quote returns 200 and the
  venue still builds a LEGACY tx (first byte 0x01) the app's decoder accepts. Unblocking step:
  stop sending `asLegacyTransaction` (and/or honor `transactionVersion` + accept v0 messages in
  the verifier) in `app/services/jupiter.ts` — one-line-class change plus executor tests; cost
  ~0 (no funds needed). Search/triage duration ~35 min. Venue rows in this file updated.
- (No free-testnet search was due: every row's last-checked was same-day/next-day and the
  affected venues are mainnet-only per the table.)
